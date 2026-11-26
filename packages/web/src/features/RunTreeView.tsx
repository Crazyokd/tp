import { useMemo, useState } from 'react';

import type { CatalogCapability, Run, RunNode, RunNodeStatus, TreeNode } from '@tp/contract';
import { findRunNode, stripRunTree } from '@tp/contract';
import { formatDuration, formatJson } from '../domain/run-progress.ts';
import { BehaviorTreeGraph, type NodePresentation } from './BehaviorTreeGraph.tsx';

export type RunTreeViewProps = {
  run: Run;
  capabilities: readonly CatalogCapability[];
  now: number;
};

const STATUS_PRESENTATION: Record<RunNodeStatus, { icon: string; label: string }> = {
  pending: { icon: '○', label: '待执行' },
  running: { icon: '◉', label: '执行中' },
  passed: { icon: '✓', label: '已通过' },
  failed: { icon: '×', label: '失败' },
  skipped: { icon: '↷', label: '已跳过' },
  canceled: { icon: '⊘', label: '已取消' },
};

export function RunTreeView({ run, capabilities, now }: RunTreeViewProps) {
  const [selection, setSelection] = useState({ runId: run.id, path: '' });
  const selectedPath = selection.runId === run.id ? selection.path : '';
  const graphDefinition = useMemo(() => stripRunTree(run.tree), [run]);
  const selected = findRunNode(run.tree, selectedPath);
  const capabilityLabels = useMemo(
    () => new Map(capabilities.map((capability) => [`${capability.adapter}::${capability.key}`, capability.label])),
    [capabilities],
  );
  const nodePresentation = useMemo(
    () => createRunNodePresentation(run.tree, capabilities, now),
    [capabilities, now, run.tree],
  );

  const selectedCapability =
    selected.type === 'Action' || selected.type === 'Condition' ? selected.capability : undefined;
  const selectedAdapter = selected.type === 'Action' || selected.type === 'Condition' ? selected.adapter : undefined;

  return (
    <div className="run-tree-view">
      <div className="run-tree-layout">
        <div className="run-tree-canvas">
          <BehaviorTreeGraph
            definition={graphDefinition}
            mode="run"
            selectedPath={selectedPath}
            onSelect={(path) => setSelection({ runId: run.id, path })}
            nodePresentation={nodePresentation}
            fitViewKey={run.id}
          />
        </div>
        <NodeDetails
          node={selected}
          path={selectedPath}
          adapter={selectedAdapter}
          capabilityLabel={
            selectedCapability && selectedAdapter
              ? (capabilityLabels.get(`${selectedAdapter}::${selectedCapability}`) ?? selectedCapability)
              : selectedCapability
          }
          now={now}
        />
      </div>
    </div>
  );
}

export function createRunNodePresentation(
  tree: Run['tree'],
  capabilities: readonly CatalogCapability[],
  now: number,
): (path: string, node: TreeNode) => NodePresentation {
  const capabilityLabels = new Map(
    capabilities.map((capability) => [`${capability.adapter}::${capability.key}`, capability.label]),
  );
  const runningAncestors = runningAncestorPaths(tree);

  return (path: string, node: TreeNode): NodePresentation => {
    const item = findRunNode(tree, path);
    const status = STATUS_PRESENTATION[item.status];
    const capability = item.type === 'Action' || item.type === 'Condition' ? item.capability : undefined;
    const adapter = item.type === 'Action' || item.type === 'Condition' ? item.adapter : undefined;
    const label =
      capability && adapter ? (capabilityLabels.get(`${adapter}::${capability}`) ?? capability) : capability;
    // attempts 只保留最近若干条（contract MAX_STORED_RUN_ATTEMPTS），
    // 已执行次数取末条编号而非数组长度。
    const retryCount =
      node.type === 'RetryUntilSuccessful'
        ? (findRunNode(tree, path ? `${path}.child` : 'child').attempts.at(-1)?.attempt ?? 0)
        : undefined;
    const executed = retryCount ?? item.attempts.at(-1)?.attempt ?? 0;
    return {
      status: item.status,
      statusLabel: `${status.icon} ${status.label}`,
      detail:
        node.type === 'RetryUntilSuccessful'
          ? `${retryCount}/${node.num_attempts === -1 ? '∞' : node.num_attempts} 次`
          : label,
      duration: attemptDuration(item, now),
      attempt: node.type === 'RetryUntilSuccessful' || executed <= 1 ? undefined : executed,
      edgeClass: runningAncestors.has(path) ? 'edge-running' : undefined,
      pathClass: runningAncestors.has(path) ? 'running-path' : undefined,
    };
  };
}

function runningAncestorPaths(tree: Run['tree']): Set<string> {
  const paths = new Set<string>();
  visitRunTree(tree, (node, path) => {
    if (node.status !== 'running') return;
    let current = path;
    while (true) {
      paths.add(current);
      if (current === '') return;
      current = parentPath(current);
    }
  });
  return paths;
}

function visitRunTree(tree: Run['tree'], visit: (node: RunNode, path: string) => void): void {
  const root = tree.trees[tree.main];
  if (!root) throw new Error(`run tree main ${tree.main} is missing`);
  walk(root, '', new Set([tree.main]));

  function walk(node: RunNode, path: string, stack: ReadonlySet<string>): void {
    visit(node, path);
    switch (node.type) {
      case 'Action':
      case 'Condition':
        return;
      case 'SubTree': {
        if (stack.has(node.id)) return;
        const target = tree.trees[node.id];
        if (!target) throw new Error(`unknown progress path ${path ? `${path}.tree` : 'tree'}`);
        walk(target, path ? `${path}.tree` : 'tree', new Set([...stack, node.id]));
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
          walk(child, path ? `${path}.children.${index}` : `children.${index}`, stack);
        });
        return;
      case 'IfThenElse':
      case 'WhileDoElse':
        walk(node.if, path ? `${path}.if` : 'if', stack);
        walk(node.then, path ? `${path}.then` : 'then', stack);
        if (node.else) walk(node.else, path ? `${path}.else` : 'else', stack);
        return;
      default:
        walk(node.child, path ? `${path}.child` : 'child', stack);
    }
  }
}

function parentPath(path: string): string {
  const parts = path.split('.');
  const last = parts.at(-1);
  if (last !== undefined && /^\d+$/.test(last) && parts.at(-2) === 'children') {
    return parts.slice(0, -2).join('.');
  }
  return parts.slice(0, -1).join('.');
}

function NodeDetails({
  node,
  path,
  adapter,
  capabilityLabel,
  now,
}: {
  node: RunNode;
  path: string;
  adapter: string | undefined;
  capabilityLabel: string | undefined;
  now: number;
}) {
  const leaf = node.type === 'Action' || node.type === 'Condition' ? node : undefined;
  const capability = leaf?.capability;
  return (
    <aside className="run-node-details" aria-label="节点执行详情">
      <h3>节点详情</h3>
      <dl>
        <div>
          <dt>类型</dt>
          <dd>{node.type}</dd>
        </div>
        <div>
          <dt>路径</dt>
          <dd>{path || 'root'}</dd>
        </div>
        {capability && (
          <div>
            <dt>Adapter</dt>
            <dd>{adapter || '—'}</dd>
          </div>
        )}
        {capability && (
          <div>
            <dt>Capability</dt>
            <dd>{capabilityLabel ?? capability}</dd>
          </div>
        )}
        {capability && (
          <div>
            <dt>Actor</dt>
            <dd>{leaf?.actor || '—'}</dd>
          </div>
        )}
      </dl>
      <section className="attempt-list">
        <h3>执行记录</h3>
        {node.attempts.length === 0 ? (
          <div className="empty">尚未执行</div>
        ) : (
          node.attempts.map((attempt) => (
            <article className={`attempt status-${attempt.status}`} key={attempt.attempt}>
              <div className="row">
                <strong>第 {attempt.attempt} 次</strong>
                <span
                  className={`run-status status-${attempt.status}`}
                  aria-label={STATUS_PRESENTATION[attempt.status].label}
                >
                  {STATUS_PRESENTATION[attempt.status].icon} {STATUS_PRESENTATION[attempt.status].label}
                </span>
              </div>
              <dl>
                <div>
                  <dt>开始</dt>
                  <dd>{attempt.startedAt}</dd>
                </div>
                <div>
                  <dt>结束</dt>
                  <dd>{attempt.finishedAt ?? '—'}</dd>
                </div>
                <div>
                  <dt>耗时</dt>
                  <dd>{formatDuration(attemptDurationMs(attempt.startedAt, attempt.finishedAt, now))}</dd>
                </div>
              </dl>
              {attempt.output !== undefined && <pre>{formatJson(attempt.output)}</pre>}
              {attempt.error && <div className="attempt-error">{attempt.error}</div>}
            </article>
          ))
        )}
      </section>
    </aside>
  );
}

function attemptDuration(node: RunNode, now: number): string | undefined {
  const attempt = node.attempts.at(-1);
  if (!attempt) return undefined;
  return formatDuration(attemptDurationMs(attempt.startedAt, attempt.finishedAt, now));
}

function attemptDurationMs(startedAt: string, finishedAt: string | null, now: number): number {
  const start = Date.parse(startedAt);
  const end = finishedAt === null ? now : Date.parse(finishedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.max(0, end - start);
}
