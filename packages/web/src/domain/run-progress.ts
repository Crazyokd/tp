import {
  stripRunTree,
  type CaseDefinition,
  type Run,
  type RunNode,
  type RunNodeStatus,
  type RunStatus,
} from '@tp/contract';

const LIVE_STATUSES = new Set<RunStatus>(['queued', 'running', 'canceling']);

export type UnifiedRun = { kind: 'active'; run: Run } | { kind: 'finished'; run: Run };

export type RunStatusCounts = Record<RunNodeStatus, number>;
export type RunTelemetry = {
  tree: Run['tree'];
  revision: number;
  graphDefinition: CaseDefinition;
};
export type SelectedRunCache = {
  snapshot: UnifiedRun;
  missingSuccessfulPolls: 0 | 1;
};

export function preferNewerRun(current: Run | undefined, incoming: Run): Run {
  if (!current || current.id !== incoming.id) return incoming;
  return incoming.revision >= current.revision ? incoming : current;
}

export function mergeIncomingRuns(previous: readonly Run[], incoming: readonly Run[]): Run[] {
  const known = new Map(previous.map((run) => [run.id, run]));
  return incoming.map((run) => preferNewerRun(known.get(run.id), run));
}

export function mergeRuns(runs: readonly Run[]): UnifiedRun[] {
  const byId = new Map<string, UnifiedRun>();
  for (const run of runs) {
    byId.set(run.id, { kind: LIVE_STATUSES.has(run.status) ? 'active' : 'finished', run });
  }

  const active = [...byId.values()]
    .filter((item): item is Extract<UnifiedRun, { kind: 'active' }> => item.kind === 'active')
    .sort(
      (left, right) =>
        timestamp(right.run.startedAt ?? right.run.createdAt) - timestamp(left.run.startedAt ?? left.run.createdAt),
    );
  const history = [...byId.values()]
    .filter((item): item is Extract<UnifiedRun, { kind: 'finished' }> => item.kind === 'finished')
    .sort(
      (left, right) =>
        timestamp(right.run.finishedAt ?? right.run.startedAt ?? right.run.createdAt) -
        timestamp(left.run.finishedAt ?? left.run.startedAt ?? left.run.createdAt),
    );
  return [...active, ...history];
}

export function selectRunId(current: string, runs: readonly UnifiedRun[]): string {
  if (current && runs.some(({ run }) => run.id === current)) return current;
  return runs.find((item) => item.kind === 'active')?.run.id ?? '';
}

export function defaultExpandedRunId(current: string | null, runs: readonly UnifiedRun[]): string | null {
  if (current !== null) return current;
  return runs.find((item) => item.kind === 'active')?.run.id ?? null;
}

export function advanceSelectedRunSnapshot(
  runs: readonly UnifiedRun[],
  expandedRunId: string,
  cache: SelectedRunCache | null,
): { cache: SelectedRunCache | null; expired: boolean } {
  if (!expandedRunId) return { cache: null, expired: false };
  const current = runs.find(({ run }) => run.id === expandedRunId);
  if (current) {
    const cached = cache?.snapshot.run.id === expandedRunId ? cache.snapshot.run : undefined;
    const run = preferNewerRun(cached, current.run);
    const snapshot: UnifiedRun = { kind: LIVE_STATUSES.has(run.status) ? 'active' : 'finished', run };
    return { cache: { snapshot, missingSuccessfulPolls: 0 }, expired: false };
  }
  if (cache?.snapshot.run.id !== expandedRunId || cache.missingSuccessfulPolls >= 1) {
    return { cache: null, expired: true };
  }
  return { cache: { ...cache, missingSuccessfulPolls: 1 }, expired: false };
}

export function visibleRunsWithSelectedSnapshot(
  runs: readonly UnifiedRun[],
  expandedRunId: string,
  cache: SelectedRunCache | null,
): UnifiedRun[] {
  if (!expandedRunId || cache?.snapshot.run.id !== expandedRunId || runs.some(({ run }) => run.id === expandedRunId))
    return [...runs];
  return cache.snapshot.kind === 'active' ? [cache.snapshot, ...runs] : [...runs, cache.snapshot];
}

export function runTreeFromRun(run: Run): RunTelemetry {
  return {
    tree: run.tree,
    revision: run.revision,
    graphDefinition: stripRunTree(run.tree),
  };
}

export function countRunNodeStatuses(tree: Run['tree']): RunStatusCounts {
  const counts: RunStatusCounts = {
    pending: 0,
    running: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    canceled: 0,
  };
  walkRunTree(tree, (node) => {
    counts[node.status] += 1;
  });
  return counts;
}

export function elapsedRunMs(run: Run, now: number): number {
  return safeDuration(timestamp(run.startedAt ?? run.createdAt), now);
}

export function runDurationMs(run: Run): number {
  return safeDuration(timestamp(run.startedAt), timestamp(run.finishedAt));
}

export function formatDuration(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return '0秒';
  if (milliseconds < 1000) return '<1秒';
  const seconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;
  return [hours > 0 ? `${hours}时` : '', minutes > 0 ? `${minutes}分` : '', `${remainingSeconds}秒`]
    .filter(Boolean)
    .join(' ');
}

export function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function walkRunTree(tree: Run['tree'], visit: (node: RunNode, path: string) => void): void {
  const root = tree.trees[tree.main];
  if (!root) throw new Error(`run tree main ${tree.main} is missing`);
  walkRunNode(tree, root, '', visit, new Set([tree.main]));
}

function walkRunNode(
  tree: Run['tree'],
  node: RunNode,
  path: string,
  visit: (node: RunNode, path: string) => void,
  stack: ReadonlySet<string>,
): void {
  visit(node, path);
  switch (node.type) {
    case 'Action':
    case 'Condition':
      return;
    case 'SubTree': {
      if (stack.has(node.id)) return;
      const target = tree.trees[node.id];
      if (!target) throw new Error(`unknown progress path ${path ? `${path}.tree` : 'tree'}`);
      walkRunNode(tree, target, path ? `${path}.tree` : 'tree', visit, new Set([...stack, node.id]));
      return;
    }
    case 'Sequence':
    case 'ReactiveSequence':
    case 'Fallback':
    case 'ReactiveFallback':
    case 'Parallel':
    case 'ParallelAll':
    case 'Switch':
      node.children.forEach((child, index) => {
        walkRunNode(tree, child, path ? `${path}.children.${index}` : `children.${index}`, visit, stack);
      });
      return;
    case 'IfThenElse':
    case 'WhileDoElse':
      walkRunNode(tree, node.if, path ? `${path}.if` : 'if', visit, stack);
      walkRunNode(tree, node.then, path ? `${path}.then` : 'then', visit, stack);
      if (node.else) walkRunNode(tree, node.else, path ? `${path}.else` : 'else', visit, stack);
      return;
    default:
      walkRunNode(tree, node.child, path ? `${path}.child` : 'child', visit, stack);
  }
}

function safeDuration(start: number, end: number): number {
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.max(0, end - start);
}

function timestamp(value: string | null | undefined): number {
  if (typeof value !== 'string') return Number.NaN;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}
