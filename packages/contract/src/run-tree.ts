import { validateCaseDocument } from './case-document.ts';
import { isJsonValue } from './json-value.ts';
import type {
  CaseDefinition,
  JsonObject,
  RunNode,
  RunNodeAttempt,
  RunNodeProgressEvent,
  RunNodeStatus,
  RunStatus,
  TreeNode,
} from './types.ts';

const PENDING: { status: RunNodeStatus; attempts: [] } = { status: 'pending', attempts: [] };

// 单节点留存的 attempt 记录上限。RetryUntilSuccessful -1 下轮询型 Condition 的
// attempts 会无限增长，拖慢快照复制和校验并耗尽内存。只保留最近若干次；
// 失败排查仍能读取末次 attempt.error，attempt 编号保持单调递增。
export const MAX_STORED_RUN_ATTEMPTS = 200;

export type RunTree = { main: string; trees: Record<string, RunNode> };

export function createRunTree(definition: unknown): RunTree {
  const document = validateCaseDocument(definition);
  return {
    main: document.main,
    trees: Object.fromEntries(Object.entries(document.trees).map(([id, node]) => [id, toRunNode(node)])),
  };
}

export function stripRunTree(tree: RunTree): CaseDefinition {
  return {
    main: tree.main,
    trees: Object.fromEntries(Object.entries(tree.trees).map(([id, node]) => [id, stripNode(node)])),
    sessions: [],
  };
}

export function findRunNode(tree: RunTree, path: string): RunNode {
  let current: RunNode | undefined = tree.trees[tree.main];
  if (!current) throw new Error(`run tree main ${tree.main} is missing`);
  if (path === '') return current;
  const parts = path.split('.');
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i]!;
    if (part === 'children') {
      const raw = parts[i + 1];
      i += 1;
      if (raw === undefined || !/^[0-9]+$/.test(raw)) {
        throw new Error(`unknown progress path ${path}`);
      }
      const index = Number.parseInt(raw, 10);
      const next: RunNode | undefined = current && 'children' in current ? current.children[index] : undefined;
      if (String(index) !== raw || next === undefined) {
        throw new Error(`unknown progress path ${path}`);
      }
      current = next;
      continue;
    }
    if (part === 'tree') {
      if (!current || current.type !== 'SubTree') throw new Error(`unknown progress path ${path}`);
      current = tree.trees[current.id];
      if (!current) throw new Error(`unknown progress path ${path}`);
      continue;
    }
    if (part === 'child' || part === 'if' || part === 'then' || part === 'else') {
      const next = current && part in current ? (current as Record<string, unknown>)[part] : undefined;
      if (!next || typeof next !== 'object') throw new Error(`unknown progress path ${path}`);
      current = next as RunNode;
      continue;
    }
    throw new Error(`unknown progress path ${path}`);
  }
  return current;
}

export type RunTreeSnapshot = { revision: number; tree: RunTree };

const FINISHED_NODE_STATUSES = new Set(['passed', 'failed', 'canceled', 'skipped']);

export function applyRunProgressEvent(snapshot: RunTreeSnapshot, event: RunNodeProgressEvent): RunTreeSnapshot {
  const next = { revision: snapshot.revision, tree: structuredClone(snapshot.tree) };
  recordRunProgressEvent(next, event);
  return next;
}

// The caller must exclusively own the snapshot and its tree.
export function recordRunProgressEvent(snapshot: RunTreeSnapshot, event: RunNodeProgressEvent): void {
  const expectedRevision = snapshot.revision + 1;
  if (!Number.isInteger(event.revision) || event.revision !== expectedRevision) {
    throw new Error(`expected revision ${expectedRevision}, received ${event.revision}`);
  }
  if (!isIsoTimestamp(event.timestamp)) {
    throw new Error('progress timestamp must be a valid ISO timestamp');
  }
  if (!Number.isInteger(event.attempt) || event.attempt < 1) {
    throw new Error('progress attempt must be a positive integer');
  }

  const tree = snapshot.tree;
  const node = findRunNode(tree, event.path);
  if (event.nodeType !== node.type) {
    throw new Error(`progress node type ${event.nodeType} does not match ${node.type}`);
  }

  if (event.kind === 'started') {
    validateStartedMetadata(node, event);
    validateStartAttempt(node, event.path, event.attempt, event.timestamp, maxAttemptsAt(tree, event.path));
    const retained =
      node.attempts.length >= MAX_STORED_RUN_ATTEMPTS
        ? node.attempts.slice(-(MAX_STORED_RUN_ATTEMPTS - 1))
        : node.attempts;
    node.attempts = [
      ...retained,
      {
        attempt: event.attempt,
        status: 'running',
        startedAt: event.timestamp,
        finishedAt: null,
      },
    ];
    node.status = 'running';
    snapshot.revision = event.revision;
    return;
  }

  validateFinishedEvent(event);
  validateFinishAttempt(node, event.path, event.attempt, event.timestamp);
  const attempt = { ...node.attempts.at(-1)! };
  attempt.status = event.status;
  attempt.finishedAt = event.timestamp;
  if (event.output !== undefined) attempt.output = structuredClone(event.output);
  if (event.error !== undefined) attempt.error = event.error;
  node.attempts = [...node.attempts.slice(0, -1), attempt];
  node.status = event.status;
  snapshot.revision = event.revision;
}

export function finalizeRunTree(snapshot: RunTreeSnapshot, status: RunStatus, error?: string): RunTreeSnapshot {
  if (status === 'failed') {
    if (!isNonEmptyString(error)) throw new Error('failed finalization requires a terminal error');
  } else if (status === 'passed' || status === 'canceled') {
    if (error !== undefined) throw new Error(`${status} finalization must not include an error`);
  } else {
    throw new Error(`cannot finalize run as ${status}`);
  }

  if (status === 'passed') {
    walkRunNodes(snapshot.tree, (node) => {
      if (node.status === 'running') {
        throw new Error('passed finalization cannot contain running nodes');
      }
    });
  }

  const tree = structuredClone(snapshot.tree);
  const finishedAt = terminalFinishedAt(tree);
  walkRunNodes(tree, (node, path) => {
    if (node.status === 'pending') {
      node.status = 'skipped';
      return;
    }
    if (node.status !== 'running') return;
    const attempt = node.attempts.at(-1);
    if (!attempt || attempt.status !== 'running') {
      throw new Error(`running node ${path} has no running attempt`);
    }
    attempt.status = status === 'failed' ? 'failed' : 'canceled';
    attempt.finishedAt = finishedAt;
    if (error !== undefined) attempt.error = error;
    node.status = attempt.status;
  });
  return { revision: snapshot.revision + 1, tree };
}

export function failedRunError(tree: RunTree): string {
  let latestAt = Number.NEGATIVE_INFINITY;
  let message: string | undefined;
  walkRunNodes(tree, (node) => {
    if (node.type !== 'Action' && node.type !== 'Condition') return;
    if (node.status !== 'failed') return;
    const attempt = lastFinishedAttempt(node);
    if (!attempt?.finishedAt) return;
    const time = Date.parse(attempt.finishedAt);
    if (!Number.isFinite(time) || time < latestAt) return;
    latestAt = time;
    if (typeof attempt.error !== 'string' || attempt.error.trim() === '') return;
    message = attempt.error;
  });
  if (message === undefined) throw new Error('failed run has no failed leaf attempt');
  return message;
}

function walkRunNodes(tree: RunTree, fn: (node: RunNode, path: string) => void): void {
  for (const [id, root] of Object.entries(tree.trees)) {
    walkNode(root, id === tree.main ? '' : id, fn);
  }
}

function walkNode(node: RunNode, path: string, fn: (node: RunNode, path: string) => void): void {
  fn(node, path);
  switch (node.type) {
    case 'Action':
    case 'Condition':
    case 'SubTree':
      return;
    case 'Sequence':
    case 'ReactiveSequence':
    case 'Fallback':
    case 'ReactiveFallback':
    case 'Parallel':
    case 'ParallelAll':
    case 'Switch':
      node.children.forEach((child, index) => {
        walkNode(child, path ? `${path}.children.${index}` : `children.${index}`, fn);
      });
      return;
    case 'IfThenElse':
    case 'WhileDoElse':
      walkNode(node.if, path ? `${path}.if` : 'if', fn);
      walkNode(node.then, path ? `${path}.then` : 'then', fn);
      if (node.else) walkNode(node.else, path ? `${path}.else` : 'else', fn);
      return;
    default:
      walkNode(node.child, path ? `${path}.child` : 'child', fn);
  }
}

function lastFinishedAttempt(node: RunNode): RunNodeAttempt | undefined {
  for (let i = node.attempts.length - 1; i >= 0; i -= 1) {
    const attempt = node.attempts[i]!;
    if (attempt.finishedAt !== null) return attempt;
  }
  return undefined;
}

function terminalFinishedAt(tree: RunTree): string {
  let timestamp = Date.now();
  walkRunNodes(tree, (node) => {
    if (node.status !== 'running') return;
    const startedAt = node.attempts.at(-1)?.startedAt;
    if (startedAt !== undefined) timestamp = Math.max(timestamp, Date.parse(startedAt));
  });
  return new Date(timestamp).toISOString();
}

function maxAttemptsAt(tree: RunTree, path: string): number {
  let current: RunNode | undefined = tree.trees[tree.main];
  if (!current) throw new Error(`run tree main ${tree.main} is missing`);
  let maxAttempts = 1;
  if (path === '') return maxAttempts;
  const parts = path.split('.');
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i]!;
    if (part === 'children') {
      const raw = parts[i + 1];
      i += 1;
      const index = Number.parseInt(raw!, 10);
      if (current?.type === 'ReactiveSequence' || current?.type === 'ReactiveFallback')
        maxAttempts = Number.MAX_SAFE_INTEGER;
      current = current && 'children' in current ? current.children[index] : undefined;
      continue;
    }
    if (part === 'tree') {
      if (!current || current.type !== 'SubTree') throw new Error(`unknown progress path ${path}`);
      current = tree.trees[current.id];
      continue;
    }
    if (part === 'child' || part === 'if' || part === 'then' || part === 'else') {
      if (part === 'child' && current && (current.type === 'RetryUntilSuccessful' || current.type === 'Repeat')) {
        const limit = current.type === 'RetryUntilSuccessful' ? current.num_attempts : current.num_cycles;
        maxAttempts = multiplyAttemptLimit(maxAttempts, limit);
      }
      const next = current && part in current ? (current as Record<string, unknown>)[part] : undefined;
      current = next as RunNode | undefined;
      continue;
    }
    throw new Error(`unknown progress path ${path}`);
  }
  if (!current) throw new Error(`unknown progress path ${path}`);
  return maxAttempts;
}

function multiplyAttemptLimit(ancestorLimit: number, retryLimit: number): number {
  if (retryLimit === -1 || ancestorLimit === Number.MAX_SAFE_INTEGER) return Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(retryLimit) || retryLimit < 1) {
    throw new Error('RetryUntilSuccessful num_attempts must be -1 or a positive safe integer');
  }
  const product = ancestorLimit * retryLimit;
  if (!Number.isSafeInteger(product)) {
    throw new Error('nested Retry maxAttempts exceed the safe integer limit');
  }
  return product;
}

function validateStartedMetadata(node: RunNode, event: Extract<RunNodeProgressEvent, { kind: 'started' }>): void {
  const capability = node.type === 'Action' || node.type === 'Condition' ? node.capability : undefined;
  const actor = node.type === 'Action' || node.type === 'Condition' ? node.actor : undefined;
  if (event.capability !== capability) {
    throw new Error(`progress capability does not match node ${event.path}`);
  }
  if (event.actor !== actor) {
    throw new Error(`progress actor does not match node ${event.path}`);
  }
}

function validateStartAttempt(
  node: RunNode,
  path: string,
  attempt: number,
  timestamp: string,
  maxAttempts: number,
): void {
  const latest = node.attempts.at(-1);
  if (latest?.status === 'running') {
    if (latest.attempt === attempt) throw new Error(`attempt ${attempt} already started`);
    throw new Error(`attempt ${latest.attempt} is still running`);
  }
  // attempts 只保留最近 MAX_STORED_RUN_ATTEMPTS 条，编号以末条为准而非数组长度。
  const expectedAttempt = latest ? latest.attempt + 1 : 1;
  if (attempt !== expectedAttempt) {
    throw new Error(`expected attempt ${expectedAttempt}, received ${attempt}`);
  }
  if (!latest) {
    if (node.status !== 'pending') throw new Error(`cannot start ${node.status} node ${path}`);
    return;
  }
  if (maxAttempts <= 1) {
    throw new Error(`cannot restart ${node.status} node ${path} outside a Retry subtree`);
  }
  if (node.status !== 'failed' && node.status !== 'passed') {
    throw new Error(`cannot restart ${node.status} node ${path}`);
  }
  if (attempt > maxAttempts) {
    throw new Error(`node ${path} reached its maximum ${maxAttempts} attempts`);
  }
  if (latest.finishedAt === null) {
    throw new Error(`completed attempt ${latest.attempt} has no finish timestamp`);
  }
  if (Date.parse(timestamp) < Date.parse(latest.finishedAt)) {
    throw new Error(`attempt ${attempt} starts before previous attempt finished`);
  }
}

function validateFinishAttempt(node: RunNode, path: string, attempt: number, timestamp: string): void {
  const latest = node.attempts.at(-1);
  if (!latest) throw new Error(`node ${path} has no running attempt`);
  if (latest.attempt !== attempt) {
    throw new Error(`finished attempt ${attempt} does not match running attempt ${latest.attempt}`);
  }
  if (latest.status !== 'running') throw new Error(`attempt ${attempt} is not running`);
  if (Date.parse(timestamp) < Date.parse(latest.startedAt)) {
    throw new Error(`attempt ${attempt} finishes before attempt start`);
  }
}

function validateFinishedEvent(event: Extract<RunNodeProgressEvent, { kind: 'finished' }>): void {
  if (!FINISHED_NODE_STATUSES.has(event.status)) {
    throw new Error(`invalid finished status ${String(event.status)}`);
  }
  if (event.output !== undefined && !isJsonObject(event.output)) {
    throw new Error('finished output must be JSON object data');
  }
  if (event.error !== undefined && !isNonEmptyString(event.error)) {
    throw new Error('finished error must be a non-empty string');
  }
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && isJsonValue(value);
}

function toRunNode(node: TreeNode): RunNode {
  switch (node.type) {
    case 'Action':
    case 'Condition':
    case 'SubTree':
      return { ...node, ...PENDING };
    case 'Sequence':
    case 'ReactiveSequence':
    case 'Fallback':
    case 'ReactiveFallback':
    case 'Parallel':
    case 'ParallelAll':
    case 'Switch':
      return { ...node, children: node.children.map(toRunNode), ...PENDING };
    case 'IfThenElse':
    case 'WhileDoElse': {
      const { else: _else, ...rest } = node;
      return {
        ...rest,
        if: toRunNode(node.if),
        then: toRunNode(node.then),
        ...(node.else ? { else: toRunNode(node.else) } : {}),
        ...PENDING,
      };
    }
    case 'RetryUntilSuccessful':
    case 'Repeat':
    case 'Timeout':
    case 'Delay':
    case 'Inverter':
    case 'ForceSuccess':
    case 'ForceFailure':
    case 'KeepRunningUntilFailure':
    case 'RunOnce':
      return { ...node, child: toRunNode(node.child), ...PENDING };
  }
}

function stripNode(node: RunNode): TreeNode {
  switch (node.type) {
    case 'Action':
    case 'Condition':
    case 'SubTree': {
      const { status: _s, attempts: _a, ...rest } = node;
      return rest;
    }
    case 'Sequence':
    case 'ReactiveSequence':
    case 'Fallback':
    case 'ReactiveFallback':
    case 'Parallel':
    case 'ParallelAll':
    case 'Switch': {
      const { status: _s, attempts: _a, ...rest } = node;
      return { ...rest, children: node.children.map(stripNode) };
    }
    case 'IfThenElse':
    case 'WhileDoElse': {
      const { status: _s, attempts: _a, else: _else, ...rest } = node;
      return {
        ...rest,
        if: stripNode(node.if),
        then: stripNode(node.then),
        ...(node.else ? { else: stripNode(node.else) } : {}),
      };
    }
    case 'RetryUntilSuccessful':
    case 'Repeat':
    case 'Timeout':
    case 'Delay':
    case 'Inverter':
    case 'ForceSuccess':
    case 'ForceFailure':
    case 'KeepRunningUntilFailure':
    case 'RunOnce': {
      const { status: _s, attempts: _a, ...rest } = node;
      return { ...rest, child: stripNode(node.child) };
    }
  }
}
