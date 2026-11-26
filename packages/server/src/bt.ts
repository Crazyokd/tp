import type { CatalogCapability, LeafTickContext, RuntimeLeaf } from '@tp/contract/adapter';
import {
  leafNodeTypes,
  validateCaseDocument,
  type JsonObject,
  type NodeStatusResult,
  type LeafNode,
  type NodePreconditions,
  type NodeStatus,
  type NodeType,
  type RunNodeProgressEvent,
  type TreeExecutionResult,
  type TreeNode,
} from '@tp/contract';

import { BlackboardError, createRunBlackboard, type RunBlackboard } from './blackboard.ts';
import { evaluatePrecondition, PreconditionError } from './bt-expr.ts';
import { applyLeafOutput, assembleLeafInput, InvalidLeafOutputError, MissingLeafInputError } from './leaf-ports.ts';

const leafTypes = new Set<string>(leafNodeTypes);
const UNKNOWN_EXECUTION_ERROR = 'Unknown execution error';

// RUNNING 主循环两次 tick 之间的最小间隔：没有它，快速叶子（毫秒级命令调用）会把循环
// 打成忙轮，progress 事件的全树克隆以每秒数千次的速率分配，直接碾压 GC 直至 worker OOM。
export const DEFAULT_TREE_TICK_INTERVAL_MS = 25;

function leafFailureError(output: JsonObject | undefined): string | undefined {
  const error = output?.error;
  return typeof error === 'string' && error.trim() !== '' ? error : undefined;
}

type Adapter = (
  node: RuntimeLeaf,
  context: LeafTickContext,
  lookup: (key: string) => unknown,
) => Promise<NodeStatusResult>;
type HaltLeaf = (node: RuntimeLeaf) => Promise<void>;
type ExecuteOptions = {
  adapter: Adapter;
  haltLeaf?: HaltLeaf;
  onProgress?: OnProgress;
  now?: Now;
  capabilities?: readonly CatalogCapability[];
  signal?: AbortSignal;
  nextRevision?: () => number;
  tickIntervalMs?: number;
  initialBlackboard?: Record<string, unknown>;
};
type OnProgress = (event: RunNodeProgressEvent) => void | Promise<void>;
type Now = () => number;
type ProgressEventWithoutRevision = RunNodeProgressEvent extends infer Event
  ? Event extends RunNodeProgressEvent
    ? Omit<Event, 'revision'>
    : never
  : never;

export class WorkerFatalError extends Error {}

class MonotonicTimestamp {
  private last = Number.NEGATIVE_INFINITY;
  private readonly now: Now;

  constructor(now: Now) {
    this.now = now;
  }

  next(): string {
    const current = this.now();
    this.last = Math.max(current, this.last);
    return new Date(this.last).toISOString();
  }
}

class ProgressEmitter {
  private revision = 0;
  private readonly allocateRevision: () => number;
  private readonly attempts = new Map<string, number>();
  private readonly callbackErrors: unknown[] = [];
  private emission = Promise.resolve();
  private readonly callback: OnProgress | undefined;
  private readonly timestamps: MonotonicTimestamp;

  constructor(callback: OnProgress | undefined, timestamps: MonotonicTimestamp, nextRevision?: () => number) {
    this.callback = callback;
    this.timestamps = timestamps;
    this.allocateRevision =
      nextRevision ??
      (() => {
        this.revision += 1;
        return this.revision;
      });
  }

  start(node: TreeNode, path: string): Promise<{ attempt: number; timestamp: string }> {
    const attempt = (this.attempts.get(path) ?? 0) + 1;
    this.attempts.set(path, attempt);
    const timestamp = this.timestamp();
    return this.emit({
      kind: 'started',
      path,
      nodeType: node.type,
      attempt,
      timestamp,
      ...(leafTypes.has(node.type)
        ? {
            capability: (node as LeafNode).capability,
            actor: (node as LeafNode).actor ?? null,
          }
        : {}),
    }).then(() => ({ attempt, timestamp }));
  }

  finish(
    node: TreeNode,
    path: string,
    attempt: number,
    status: 'passed' | 'failed' | 'canceled' | 'skipped',
    details: { output?: JsonObject; error?: string } = {},
  ): Promise<void> {
    return this.emit({
      kind: 'finished',
      path,
      nodeType: node.type,
      attempt,
      timestamp: this.timestamp(),
      status,
      ...details,
    });
  }

  isCallbackError(error: unknown): boolean {
    return this.callbackErrors.some((candidate) => Object.is(candidate, error));
  }

  timestamp(): string {
    return this.timestamps.next();
  }

  private emit(event: ProgressEventWithoutRevision): Promise<void> {
    if (!this.callback) return Promise.resolve();
    const next = this.emission.then(async () => {
      const revision = this.allocateRevision();
      const progressEvent = structuredClone({ ...event, revision }) as RunNodeProgressEvent;
      try {
        await this.callback!(progressEvent);
      } catch (error) {
        this.callbackErrors.push(error);
        throw error;
      }
    });
    this.emission = next;
    return next;
  }
}

type LeafWork = {
  promise: Promise<NodeStatusResult>;
};

class TreeRuntime {
  readonly leafWork = new Map<string, LeafWork>();
  readonly leafErrors = new Map<string, unknown>();
  readonly board: RunBlackboard;
  readonly capabilities: Map<string, CatalogCapability>;
  readonly adapter: Adapter;
  readonly haltLeaf: HaltLeaf;
  readonly progress: ProgressEmitter;
  readonly now: Now;
  readonly signal: AbortSignal | undefined;
  private readonly started = new Set<string>();
  private readonly attempts = new Map<string, number>();

  constructor(
    adapter: Adapter,
    haltLeaf: HaltLeaf,
    progress: ProgressEmitter,
    board: RunBlackboard,
    capabilities: Map<string, CatalogCapability>,
    now: Now,
    signal: AbortSignal | undefined,
  ) {
    this.adapter = adapter;
    this.haltLeaf = haltLeaf;
    this.progress = progress;
    this.board = board;
    this.capabilities = capabilities;
    this.now = now;
    this.signal = signal;
  }

  async markStart(node: TreeNode, path: string): Promise<void> {
    if (this.started.has(path)) return;
    this.started.add(path);
    const { attempt } = await this.progress.start(node, path);
    this.attempts.set(path, attempt);
  }

  async markFinish(
    node: TreeNode,
    path: string,
    status: NodeStatus,
    details: { output?: JsonObject; error?: string } = {},
  ): Promise<void> {
    if (!this.started.has(path)) return;
    this.started.delete(path);
    const attempt = this.attempts.get(path) ?? 1;
    await this.progress.finish(
      node,
      path,
      attempt,
      status === 'SUCCESS' ? 'passed' : status === 'SKIPPED' ? 'skipped' : this.signal?.aborted ? 'canceled' : 'failed',
      details,
    );
  }

  clearStart(path: string): void {
    this.started.delete(path);
    for (const key of [...this.started]) {
      if (key.startsWith(`${path}.`)) this.started.delete(key);
    }
  }
}

interface BtNode {
  tick(): Promise<NodeStatus>;
  halt(): Promise<void>;
  reset(): void;
  status(): NodeStatus;
}

abstract class BaseNode implements BtNode {
  protected current: NodeStatus = 'IDLE';
  protected readonly runtime: TreeRuntime;
  protected readonly path: string;
  protected readonly ast: TreeNode;

  constructor(runtime: TreeRuntime, path: string, ast: TreeNode) {
    this.runtime = runtime;
    this.path = path;
    this.ast = ast;
  }

  status(): NodeStatus {
    return this.current;
  }

  async tick(): Promise<NodeStatus> {
    try {
      const precondition = this.evaluatePreconditions();
      if (precondition) {
        await this.runtime.markStart(this.ast, this.path);
        this.current = precondition;
        await this.runtime.markFinish(this.ast, this.path, precondition);
        return precondition;
      }
      await this.runtime.markStart(this.ast, this.path);
      this.current = await this.tickBody();
      if (this.current !== 'RUNNING') await this.runtime.markFinish(this.ast, this.path, this.current);
      return this.current;
    } catch (error) {
      if (!(error instanceof WorkerFatalError) && !this.runtime.progress.isCallbackError(error)) {
        await this.runtime.markFinish(this.ast, this.path, 'FAILURE');
      }
      throw error;
    }
  }

  async halt(): Promise<void> {
    await this.haltBody();
    this.current = 'IDLE';
    await this.runtime.markFinish(this.ast, this.path, 'FAILURE');
  }

  reset(): void {
    this.current = 'IDLE';
    this.runtime.clearStart(this.path);
  }

  protected evaluatePreconditions(): NodeStatus | undefined {
    const node = this.ast as NodePreconditions;
    const lookup = (key: string) => {
      const value = this.runtime.board.peek(key);
      if (value === undefined) throw new PreconditionError(`blackboard key ${key} is missing`);
      return value;
    };
    try {
      if (node._skipIf && evaluatePrecondition(node._skipIf, lookup)) return 'SKIPPED';
      if (node._successIf && evaluatePrecondition(node._successIf, lookup)) return 'SUCCESS';
      if (node._failureIf && evaluatePrecondition(node._failureIf, lookup)) return 'FAILURE';
      return undefined;
    } catch (error) {
      if (error instanceof PreconditionError || error instanceof BlackboardError) {
        throw new WorkerFatalError(error.message, { cause: error });
      }
      throw error;
    }
  }

  protected abstract tickBody(): Promise<NodeStatus>;
  protected abstract haltBody(): Promise<void>;
}

class MemoryControl extends BaseNode {
  private index = 0;
  private readonly kind: 'sequence' | 'fallback';
  private readonly children: BtNode[];

  constructor(runtime: TreeRuntime, path: string, ast: TreeNode, kind: 'sequence' | 'fallback', children: BtNode[]) {
    super(runtime, path, ast);
    this.kind = kind;
    this.children = children;
  }

  protected async tickBody(): Promise<NodeStatus> {
    while (this.index < this.children.length) {
      const status = await this.children[this.index]!.tick();
      if (status === 'RUNNING') return 'RUNNING';
      if (this.kind === 'sequence' && status === 'FAILURE') return 'FAILURE';
      if (this.kind === 'fallback' && status === 'SUCCESS') return 'SUCCESS';
      this.index += 1;
    }
    return this.kind === 'sequence' ? 'SUCCESS' : 'FAILURE';
  }

  protected async haltBody(): Promise<void> {
    await Promise.all(this.children.map((child) => child.halt()));
  }

  override reset(): void {
    super.reset();
    this.index = 0;
    for (const child of this.children) child.reset();
  }
}

class ReactiveControl extends BaseNode {
  private readonly kind: 'sequence' | 'fallback';
  private readonly children: BtNode[];

  constructor(runtime: TreeRuntime, path: string, ast: TreeNode, kind: 'sequence' | 'fallback', children: BtNode[]) {
    super(runtime, path, ast);
    this.kind = kind;
    this.children = children;
  }

  protected async tickBody(): Promise<NodeStatus> {
    for (const [index, child] of this.children.entries()) {
      const status = await child.tick();
      if (status === 'RUNNING') return 'RUNNING';
      if (this.kind === 'sequence' && status === 'FAILURE') {
        await Promise.all(this.children.slice(index + 1).map((item) => item.halt()));
        return 'FAILURE';
      }
      if (this.kind === 'fallback' && status === 'SUCCESS') {
        await Promise.all(this.children.slice(index + 1).map((item) => item.halt()));
        return 'SUCCESS';
      }
      if (status === 'SUCCESS' || status === 'FAILURE' || status === 'SKIPPED') child.reset();
    }
    return this.kind === 'sequence' ? 'SUCCESS' : 'FAILURE';
  }

  protected async haltBody(): Promise<void> {
    await Promise.all(this.children.map((child) => child.halt()));
  }

  override reset(): void {
    super.reset();
    for (const child of this.children) child.reset();
  }
}

class ParallelControl extends BaseNode {
  private readonly terminals = new Map<number, NodeStatus>();
  private readonly children: BtNode[];
  private readonly successNeed: number;
  private readonly failureNeed: number;

  constructor(
    runtime: TreeRuntime,
    path: string,
    ast: TreeNode,
    children: BtNode[],
    successNeed: number,
    failureNeed: number,
  ) {
    super(runtime, path, ast);
    this.children = children;
    this.successNeed = successNeed;
    this.failureNeed = failureNeed;
  }

  protected async tickBody(): Promise<NodeStatus> {
    const results: NodeStatus[] = [];
    for (const [index, child] of this.children.entries()) {
      const cached = this.terminals.get(index);
      if (cached) {
        results.push(cached);
        continue;
      }
      try {
        const status = await child.tick();
        if (status !== 'RUNNING') this.terminals.set(index, status);
        results.push(status);
      } catch (error) {
        if (error instanceof WorkerFatalError || this.runtime.progress.isCallbackError(error)) throw error;
        this.terminals.set(index, 'FAILURE');
        this.runtime.leafErrors.set(`${this.path}:${index}`, error);
        results.push('FAILURE');
      }
    }
    const thrown = [...this.runtime.leafErrors.entries()].find(([key]) => key.startsWith(`${this.path}:`));
    if (this.ast.type === 'ParallelAll') {
      if (results.every((status) => status !== 'RUNNING')) {
        if (thrown?.[1]) throw thrown[1];
        const maxFailures =
          this.ast.max_failures === undefined
            ? 1
            : this.ast.max_failures < 0
              ? this.children.length
              : this.ast.max_failures;
        const failures = results.filter((status) => status === 'FAILURE').length;
        return failures >= maxFailures ? 'FAILURE' : 'SUCCESS';
      }
      return 'RUNNING';
    }
    {
      const successes = results.filter((status) => status === 'SUCCESS' || status === 'SKIPPED').length;
      const failures = results.filter((status) => status === 'FAILURE').length;
      if (successes >= this.successNeed) {
        await this.haltRunning(results);
        return 'SUCCESS';
      }
      if (failures >= this.failureNeed) {
        await this.haltRunning(results);
        return 'FAILURE';
      }
    }
    if (results.every((status) => status !== 'RUNNING')) {
      if (thrown?.[1]) throw thrown[1];
      return results.some((status) => status === 'FAILURE') ? 'FAILURE' : 'SUCCESS';
    }
    return 'RUNNING';
  }

  private async haltRunning(results: NodeStatus[]): Promise<void> {
    await Promise.all(
      this.children.map((child, index) => (results[index] === 'RUNNING' ? child.halt() : Promise.resolve())),
    );
  }

  protected async haltBody(): Promise<void> {
    await Promise.all(this.children.map((child) => child.halt()));
  }

  override reset(): void {
    super.reset();
    this.terminals.clear();
    for (const child of this.children) child.reset();
  }
}

class DecoratorNode extends BaseNode {
  private readonly child: BtNode;
  private readonly map: (status: NodeStatus, child: BtNode) => NodeStatus | Promise<NodeStatus>;

  constructor(
    runtime: TreeRuntime,
    path: string,
    ast: TreeNode,
    child: BtNode,
    map: (status: NodeStatus, child: BtNode) => NodeStatus | Promise<NodeStatus>,
  ) {
    super(runtime, path, ast);
    this.child = child;
    this.map = map;
  }

  protected tickBody(): Promise<NodeStatus> {
    return Promise.resolve(this.child.tick()).then((status) => this.map(status, this.child));
  }

  protected haltBody(): Promise<void> {
    return this.child.halt();
  }

  override reset(): void {
    super.reset();
    this.child.reset();
  }
}

class RetryNode extends BaseNode {
  private used = 0;
  private readonly child: BtNode;

  constructor(
    runtime: TreeRuntime,
    path: string,
    ast: Extract<TreeNode, { type: 'RetryUntilSuccessful' }>,
    child: BtNode,
  ) {
    super(runtime, path, ast);
    this.child = child;
  }

  protected async tickBody(): Promise<NodeStatus> {
    const status = await this.child.tick();
    if (status === 'SUCCESS' || status === 'RUNNING' || status === 'SKIPPED') return status;
    this.used += 1;
    const limit = (this.ast as Extract<TreeNode, { type: 'RetryUntilSuccessful' }>).num_attempts;
    if (limit !== -1 && this.used >= limit) return 'FAILURE';
    this.child.reset();
    return 'RUNNING';
  }

  protected haltBody(): Promise<void> {
    return this.child.halt();
  }

  override reset(): void {
    super.reset();
    this.used = 0;
    this.child.reset();
  }
}

class RepeatNode extends BaseNode {
  private used = 0;
  private readonly child: BtNode;

  constructor(runtime: TreeRuntime, path: string, ast: Extract<TreeNode, { type: 'Repeat' }>, child: BtNode) {
    super(runtime, path, ast);
    this.child = child;
  }

  protected async tickBody(): Promise<NodeStatus> {
    const status = await this.child.tick();
    if (status === 'FAILURE' || status === 'RUNNING') return status;
    this.used += 1;
    const limit = (this.ast as Extract<TreeNode, { type: 'Repeat' }>).num_cycles;
    if (limit !== -1 && this.used >= limit) return 'SUCCESS';
    this.child.reset();
    return 'RUNNING';
  }

  protected haltBody(): Promise<void> {
    return this.child.halt();
  }

  override reset(): void {
    super.reset();
    this.used = 0;
    this.child.reset();
  }
}

class TimeoutNode extends BaseNode {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private timedOut = false;
  private readonly child: BtNode;

  constructor(runtime: TreeRuntime, path: string, ast: Extract<TreeNode, { type: 'Timeout' }>, child: BtNode) {
    super(runtime, path, ast);
    this.child = child;
  }

  protected async tickBody(): Promise<NodeStatus> {
    if (this.timedOut) {
      await this.child.halt();
      this.clearTimer();
      return 'FAILURE';
    }
    const status = await this.child.tick();
    if (status !== 'RUNNING') {
      this.clearTimer();
      return status;
    }
    const msec = (this.ast as Extract<TreeNode, { type: 'Timeout' }>).msec;
    if (!this.timer) {
      this.timer = setTimeout(() => {
        if (this.child.status() === 'RUNNING') this.timedOut = true;
      }, msec);
    }
    return 'RUNNING';
  }

  protected async haltBody(): Promise<void> {
    this.clearTimer();
    await this.child.halt();
  }

  override reset(): void {
    super.reset();
    this.clearTimer();
    this.timedOut = false;
    this.child.reset();
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}

class DelayNode extends BaseNode {
  private startedAt: number | undefined;
  private readonly child: BtNode;

  constructor(runtime: TreeRuntime, path: string, ast: Extract<TreeNode, { type: 'Delay' }>, child: BtNode) {
    super(runtime, path, ast);
    this.child = child;
  }

  protected async tickBody(): Promise<NodeStatus> {
    this.startedAt ??= this.runtime.now();
    if (this.runtime.now() - this.startedAt < (this.ast as Extract<TreeNode, { type: 'Delay' }>).msec) return 'RUNNING';
    return this.child.tick();
  }

  protected haltBody(): Promise<void> {
    return this.child.halt();
  }

  override reset(): void {
    super.reset();
    this.startedAt = undefined;
    this.child.reset();
  }
}

class IfNode extends BaseNode {
  private readonly condition: BtNode;
  private readonly thenNode: BtNode;
  private readonly elseNode: BtNode | undefined;
  private readonly loop: boolean;

  constructor(
    runtime: TreeRuntime,
    path: string,
    ast: Extract<TreeNode, { type: 'IfThenElse' | 'WhileDoElse' }>,
    condition: BtNode,
    thenNode: BtNode,
    elseNode: BtNode | undefined,
    loop: boolean,
  ) {
    super(runtime, path, ast);
    this.condition = condition;
    this.thenNode = thenNode;
    this.elseNode = elseNode;
    this.loop = loop;
  }

  protected async tickBody(): Promise<NodeStatus> {
    if (this.loop) this.condition.reset();
    const condition = await this.condition.tick();
    if (condition === 'RUNNING' || condition === 'SKIPPED') return condition;
    const branch = condition === 'SUCCESS' ? this.thenNode : this.elseNode;
    if (!branch) return condition;
    const status = await branch.tick();
    if (this.loop && status === 'SUCCESS') {
      this.thenNode.reset();
      this.elseNode?.reset();
      return 'RUNNING';
    }
    return status;
  }

  protected async haltBody(): Promise<void> {
    await this.condition.halt();
    await this.thenNode.halt();
    if (this.elseNode) await this.elseNode.halt();
  }

  override reset(): void {
    super.reset();
    this.condition.reset();
    this.thenNode.reset();
    this.elseNode?.reset();
  }
}

class SwitchControl extends BaseNode {
  private readonly children: BtNode[];

  constructor(runtime: TreeRuntime, path: string, ast: Extract<TreeNode, { type: 'Switch' }>, children: BtNode[]) {
    super(runtime, path, ast);
    this.children = children;
  }

  protected tickBody(): Promise<NodeStatus> {
    const node = this.ast as Extract<TreeNode, { type: 'Switch' }>;
    const raw = this.runtime.board.peek(node.variable);
    const matched = node.cases.findIndex((value) => value === String(raw));
    const index = matched >= 0 ? matched : Math.max(0, this.children.length - 1);
    const child = this.children[index];
    if (!child) return Promise.resolve('FAILURE');
    return child.tick();
  }

  protected async haltBody(): Promise<void> {
    await Promise.all(this.children.map((child) => child.halt()));
  }

  override reset(): void {
    super.reset();
    for (const child of this.children) child.reset();
  }
}

class SubTreeControl extends BaseNode {
  private readonly child: BtNode;

  constructor(runtime: TreeRuntime, path: string, ast: Extract<TreeNode, { type: 'SubTree' }>, child: BtNode) {
    super(runtime, path, ast);
    this.child = child;
  }

  protected async tickBody(): Promise<NodeStatus> {
    this.runtime.board.pushAlias((this.ast as Extract<TreeNode, { type: 'SubTree' }>).remap);
    try {
      return await this.child.tick();
    } finally {
      this.runtime.board.pop();
    }
  }

  protected async haltBody(): Promise<void> {
    this.runtime.board.pushAlias((this.ast as Extract<TreeNode, { type: 'SubTree' }>).remap);
    try {
      await this.child.halt();
    } finally {
      this.runtime.board.pop();
    }
  }

  override reset(): void {
    super.reset();
    this.child.reset();
  }
}

class RunOnceNode extends BaseNode {
  private cached: NodeStatus | undefined;
  private readonly child: BtNode;

  constructor(runtime: TreeRuntime, path: string, ast: TreeNode, child: BtNode) {
    super(runtime, path, ast);
    this.child = child;
  }

  protected async tickBody(): Promise<NodeStatus> {
    if (this.cached) return this.cached;
    const status = await this.child.tick();
    if (status !== 'RUNNING') this.cached = status;
    return status;
  }

  protected haltBody(): Promise<void> {
    return this.child.halt();
  }

  override reset(): void {
    super.reset();
    this.cached = undefined;
    this.child.reset();
  }
}

class LeafBtNode extends BaseNode {
  constructor(runtime: TreeRuntime, path: string, ast: LeafNode) {
    super(runtime, path, ast);
  }

  protected async tickBody(): Promise<NodeStatus> {
    const node = this.ast as LeafNode;
    const capability = this.runtime.capabilities.get(`${node.adapter}::${node.capability}`);
    if (!capability) {
      throw new WorkerFatalError(`capability ${node.adapter}/${node.capability} is not registered`);
    }

    let work = this.runtime.leafWork.get(this.path);
    if (!work) {
      let input: JsonObject;
      try {
        input = assembleLeafInput(node, capability, (key) => this.runtime.board.peek(key));
      } catch (error) {
        if (error instanceof MissingLeafInputError) {
          await this.runtime.markFinish(node, this.path, 'FAILURE', { error: error.message });
          return 'FAILURE';
        }
        throw error;
      }
      const promise = this.runtime.adapter(runtimeLeaf(node, this.path), { input }, (key) =>
        this.runtime.board.peek(key),
      );
      void promise.catch(() => undefined);
      work = { promise };
      this.runtime.leafWork.set(this.path, work);
      await Promise.resolve();
    }

    if (!(await isSettled(work.promise))) return 'RUNNING';
    this.runtime.leafWork.delete(this.path);

    try {
      const result = await work.promise;
      applyLeafOutput(node, capability, result.output, (key, value) => this.runtime.board.write(key, value));
      if (result.status === 'RUNNING') {
        if (node.type === 'Condition') {
          throw new WorkerFatalError('Condition tick must not return RUNNING');
        }
        return 'RUNNING';
      }
      if (result.status === 'FAILURE') {
        const error = leafFailureError(result.output);
        await this.runtime.markFinish(node, this.path, 'FAILURE', {
          output: result.output,
          ...(error !== undefined ? { error } : {}),
        });
        return 'FAILURE';
      }
      if (result.status !== 'SUCCESS') {
        throw new WorkerFatalError(`invalid leaf status ${String(result.status)}`);
      }
      await this.runtime.markFinish(node, this.path, 'SUCCESS', { output: result.output });
      return 'SUCCESS';
    } catch (error) {
      if (error instanceof MissingLeafInputError) {
        await this.runtime.markFinish(node, this.path, 'FAILURE', { error: error.message });
        return 'FAILURE';
      }
      if (error instanceof InvalidLeafOutputError) {
        throw new WorkerFatalError(error.message, { cause: error });
      }
      if (this.runtime.progress.isCallbackError(error) || error instanceof WorkerFatalError) throw error;
      throw new WorkerFatalError(safeExecutionErrorText(error) || UNKNOWN_EXECUTION_ERROR, { cause: error });
    }
  }

  protected async haltBody(): Promise<void> {
    const node = this.ast as LeafNode;
    this.runtime.leafWork.delete(this.path);
    await this.runtime.haltLeaf(runtimeLeaf(node, this.path));
  }
}

function instantiate(
  node: TreeNode,
  path: string,
  runtime: TreeRuntime,
  trees: Record<string, TreeNode>,
  stack: string[],
): BtNode {
  const child = (segment: string, next: TreeNode) => instantiate(next, childPath(path, segment), runtime, trees, stack);
  switch (node.type) {
    case 'Sequence':
      return new MemoryControl(
        runtime,
        path,
        node,
        'sequence',
        node.children.map((item, index) => child(`children.${index}`, item)),
      );
    case 'Fallback':
      return new MemoryControl(
        runtime,
        path,
        node,
        'fallback',
        node.children.map((item, index) => child(`children.${index}`, item)),
      );
    case 'ReactiveSequence':
      return new ReactiveControl(
        runtime,
        path,
        node,
        'sequence',
        node.children.map((item, index) => child(`children.${index}`, item)),
      );
    case 'ReactiveFallback':
      return new ReactiveControl(
        runtime,
        path,
        node,
        'fallback',
        node.children.map((item, index) => child(`children.${index}`, item)),
      );
    case 'Parallel': {
      const success =
        node.success_count === undefined || node.success_count < 0 ? node.children.length : node.success_count;
      const failure =
        node.failure_count === undefined ? 1 : node.failure_count < 0 ? node.children.length : node.failure_count;
      return new ParallelControl(
        runtime,
        path,
        node,
        node.children.map((item, index) => child(`children.${index}`, item)),
        success,
        failure,
      );
    }
    case 'ParallelAll':
      return new ParallelControl(
        runtime,
        path,
        node,
        node.children.map((item, index) => child(`children.${index}`, item)),
        node.children.length,
        node.children.length + 1,
      );
    case 'RetryUntilSuccessful':
      return new RetryNode(runtime, path, node, child('child', node.child));
    case 'Repeat':
      return new RepeatNode(runtime, path, node, child('child', node.child));
    case 'Timeout':
      return new TimeoutNode(runtime, path, node, child('child', node.child));
    case 'Delay':
      return new DelayNode(runtime, path, node, child('child', node.child));
    case 'Inverter':
      return new DecoratorNode(runtime, path, node, child('child', node.child), (status) =>
        status === 'SUCCESS' ? 'FAILURE' : status === 'FAILURE' ? 'SUCCESS' : status,
      );
    case 'ForceSuccess':
      return new DecoratorNode(runtime, path, node, child('child', node.child), (status) =>
        status === 'RUNNING' || status === 'SKIPPED' ? status : 'SUCCESS',
      );
    case 'ForceFailure':
      return new DecoratorNode(runtime, path, node, child('child', node.child), (status) =>
        status === 'RUNNING' || status === 'SKIPPED' ? status : 'FAILURE',
      );
    case 'KeepRunningUntilFailure':
      return new DecoratorNode(runtime, path, node, child('child', node.child), (status, instance) => {
        if (status === 'FAILURE') return 'FAILURE';
        if (status === 'SUCCESS') {
          instance.reset();
          return 'RUNNING';
        }
        return status;
      });
    case 'RunOnce':
      return new RunOnceNode(runtime, path, node, child('child', node.child));
    case 'IfThenElse':
    case 'WhileDoElse':
      return new IfNode(
        runtime,
        path,
        node,
        child('if', node.if),
        child('then', node.then),
        node.else ? child('else', node.else) : undefined,
        node.type === 'WhileDoElse',
      );
    case 'Switch':
      return new SwitchControl(
        runtime,
        path,
        node,
        node.children.map((item, index) => child(`children.${index}`, item)),
      );
    case 'SubTree': {
      if (stack.includes(node.id)) throw new Error(`SubTree ${node.id} is recursive`);
      const target = trees[node.id];
      if (!target) throw new Error(`SubTree ${node.id} is not defined`);
      return new SubTreeControl(
        runtime,
        path,
        node,
        instantiate(target, childPath(path, 'tree'), runtime, trees, [...stack, node.id]),
      );
    }
    case 'Action':
    case 'Condition':
      return new LeafBtNode(runtime, path, node);
    default:
      throw new Error(`unsupported node type ${(node as { type?: string }).type}`);
  }
}

export async function executeTree(rawDefinition: unknown, options: ExecuteOptions): Promise<TreeExecutionResult> {
  const document = validateCaseDocument(rawDefinition);
  if (typeof options.adapter !== 'function') throw new Error('adapter is required');
  const adapter = options.adapter;
  const progress = new ProgressEmitter(
    options.onProgress,
    new MonotonicTimestamp(options.now ?? Date.now),
    options.nextRevision,
  );
  const board = createRunBlackboard();
  for (const [key, value] of Object.entries(options.initialBlackboard ?? {})) {
    board.write(key, value);
  }
  const capabilities = new Map(
    (options.capabilities ?? []).map((capability) => [`${capability.adapter}::${capability.key}`, capability]),
  );
  const runtime = new TreeRuntime(
    adapter,
    options.haltLeaf ?? (async () => undefined),
    progress,
    board,
    capabilities,
    options.now ?? Date.now,
    options.signal,
  );
  const rootAst = document.trees[document.main];
  if (!rootAst) throw new Error(`definition.main ${document.main} is not in trees`);
  const root = instantiate(rootAst, '', runtime, document.trees, [document.main]);

  const tickIntervalMs = options.tickIntervalMs ?? DEFAULT_TREE_TICK_INTERVAL_MS;
  try {
    let status = await root.tick();
    while (status === 'RUNNING' && !options.signal?.aborted) {
      await yieldTick(tickIntervalMs, options.signal);
      status = await root.tick();
    }
    if (options.signal?.aborted) {
      await root.halt();
      return { status: 'canceled' };
    }
    return {
      status: status === 'SUCCESS' || status === 'SKIPPED' ? 'passed' : 'failed',
    };
  } catch (error) {
    if (error instanceof WorkerFatalError) throw error;
    if (progress.isCallbackError(error)) throw error;
    throw error;
  }
}

function childPath(parent: string, segment: string): string {
  return parent === '' ? segment : `${parent}.${segment}`;
}

function safeExecutionErrorText(error: unknown): string {
  try {
    if (!(error instanceof Error)) return String(error);
    const message: unknown = error.message;
    return typeof message === 'string' ? message : String(message);
  } catch {
    return UNKNOWN_EXECUTION_ERROR;
  }
}

function runtimeLeaf(node: LeafNode, path: string): RuntimeLeaf {
  return { ...node, path };
}

function yieldTick(intervalMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, Math.max(0, intervalMs));
    const onAbort = () => {
      clearTimeout(timer);
      done();
    };
    function done(): void {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function isSettled(promise: Promise<unknown>): Promise<boolean> {
  let settled = false;
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await Promise.resolve();
  return settled;
}

export type { NodeType };
