import { File, FileText, Film, Image } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import type { Batch, CatalogCapability, RunStatus, TestCase } from '@tp/contract';
import { artifactKind, runArtifactItems } from '../domain/run-artifacts.ts';
import {
  countRunNodeStatuses,
  elapsedRunMs,
  formatDuration,
  runDurationMs,
  runTreeFromRun,
  type UnifiedRun,
} from '../domain/run-progress.ts';
import { RunTreeView } from './RunTreeView.tsx';

type Props = {
  batches: Batch[];
  total: number;
  offset: number;
  pageSize: number;
  pageLoading: boolean;
  onPageChange: (offset: number) => void | Promise<void>;
  runs: UnifiedRun[];
  cases: readonly TestCase[];
  capabilities: readonly CatalogCapability[];
  expandedRunId: string | null;
  focusBatchId: string | null;
  now: number;
  onToggle: (item: UnifiedRun) => void;
  onCancelBatch?: (batchId: string) => void | Promise<void>;
  onCancel?: (runId: string) => void | Promise<void>;
};

export function RunsPage({
  batches,
  total,
  offset,
  pageSize,
  pageLoading,
  onPageChange,
  runs,
  cases,
  capabilities,
  expandedRunId,
  focusBatchId,
  now,
  onToggle,
  onCancel,
  onCancelBatch,
}: Props) {
  const positionedBatch = useRef<string | null>(null);
  useEffect(() => {
    if (!focusBatchId) {
      positionedBatch.current = null;
      return;
    }
    if (positionedBatch.current === focusBatchId) return;
    positionedBatch.current = null;
    const batch = document.querySelector('[data-batch-focus="true"]');
    if (!batch) return;
    batch.scrollIntoView({ block: 'start' });
    batch.querySelector('button')?.focus({ preventScroll: true });
    positionedBatch.current = focusBatchId;
  }, [focusBatchId, batches]);

  return (
    <section className="runs-section" data-testid="runs-page">
      <div className="section-head">
        <h2>Runs List</h2>
        <nav className="toolbar" aria-label="Run 批次分页">
          <span className="meta" role="status">
            共 {total} 个批次 · 第 {Math.floor(offset / pageSize) + 1} / {Math.max(1, Math.ceil(total / pageSize))} 页
          </span>
          <button type="button" disabled={pageLoading || offset === 0} onClick={() => onPageChange(offset - pageSize)}>
            上一页
          </button>
          <button
            type="button"
            disabled={pageLoading || offset + pageSize >= total}
            onClick={() => onPageChange(offset + pageSize)}
          >
            下一页
          </button>
        </nav>
      </div>
      <div className="runs-list" aria-busy={pageLoading}>
        {batches.length === 0 ? (
          <div className="empty">暂无 Run</div>
        ) : (
          batches.map((batch) => (
            <RunFold
              batch={batch}
              items={batch.runs.map(
                (run) =>
                  runs.find((item) => item.run.id === run.id) ?? {
                    kind:
                      run.status === 'queued' || run.status === 'running' || run.status === 'canceling'
                        ? 'active'
                        : 'finished',
                    run,
                  },
              )}
              cases={cases}
              capabilities={capabilities}
              expandedRunId={expandedRunId}
              focusBatchId={focusBatchId}
              key={batch.id}
              now={now}
              onToggle={onToggle}
              onCancel={onCancel}
              onCancelBatch={onCancelBatch}
            />
          ))
        )}
      </div>
    </section>
  );
}

function RunFold({
  batch,
  items,
  cases,
  capabilities,
  expandedRunId,
  focusBatchId,
  now,
  onToggle,
  onCancel,
  onCancelBatch,
}: {
  batch: Batch;
  onCancelBatch?: (batchId: string) => void | Promise<void>;
  items: UnifiedRun[];
  cases: readonly TestCase[];
  capabilities: readonly CatalogCapability[];
  expandedRunId: string | null;
  focusBatchId: string | null;
  now: number;
  onToggle: (item: UnifiedRun) => void;
  onCancel?: (runId: string) => void | Promise<void>;
}) {
  const batchId = batch.id;
  const focused = focusBatchId === batchId && batchId !== '';
  const [open, setOpen] = useState(true);
  useEffect(() => {
    if (focused) setOpen(true);
  }, [focused]);
  const active = batch.status === 'queued' || batch.status === 'running';
  return (
    <section
      className="run-fold"
      data-batch-focus={focused ? 'true' : undefined}
      data-batch-id={batchId}
      data-testid="run-fold"
    >
      <div className="run-fold-head">
        <button
          className="run-fold-toggle"
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <span className="title">{batch.name}</span>
          <span className="meta">
            {batch.id} · {batch.runs.length} 条
          </span>
        </button>
        <span className={`pill ${batch.status}`} aria-label="批次状态">
          {runStatusLabel(batch.status)}
        </span>
        <span className="run-counts" aria-label="批次统计">
          {Object.entries(batch.counts)
            .filter(([, count]) => count > 0)
            .map(([status, count]) => (
              <span key={status}>
                {runStatusLabel(status as RunStatus)} {count}
              </span>
            ))}
        </span>
        {active && onCancelBatch ? (
          <button
            className="danger"
            data-testid="cancel-batch"
            type="button"
            onClick={() => {
              void onCancelBatch(batch.id);
            }}
          >
            停止
          </button>
        ) : null}
      </div>
      <div className="batch-metadata">
        {batch.description && <p>{batch.description}</p>}
        <span className="meta">声明来源：{batch.trigger.kind}</span>
        {batch.selection.kind === 'group' && <span className="meta">Group：{batch.selection.groupName}</span>}
        {batch.trigger.kind === 'ci' && batch.trigger.pipelineUrl && (
          <a href={batch.trigger.pipelineUrl} rel="noreferrer noopener" target="_blank">
            CI Pipeline
          </a>
        )}
      </div>
      {open
        ? items.map((item) => (
            <RunCard
              item={item}
              cases={cases}
              capabilities={capabilities}
              expanded={expandedRunId === item.run.id}
              key={item.run.id}
              now={now}
              onToggle={() => onToggle(item)}
              onCancel={onCancel}
            />
          ))
        : null}
    </section>
  );
}

function RunCard({
  item,
  cases,
  capabilities,
  expanded,
  now,
  onToggle,
  onCancel,
}: {
  item: UnifiedRun;
  cases: readonly TestCase[];
  capabilities: readonly CatalogCapability[];
  expanded: boolean;
  now: number;
  onToggle: () => void;
  onCancel?: (runId: string) => void;
}) {
  const { run } = item;
  const telemetry = useMemo(() => runTreeFromRun(run), [run]);
  const counts = useMemo(() => countRunNodeStatuses(telemetry.tree), [telemetry.tree]);
  const duration = item.kind === 'active' ? elapsedRunMs(item.run, now) : runDurationMs(item.run);
  const caseName = cases.find((itemCase) => itemCase.id === run.caseId)?.name ?? run.caseId;
  return (
    <article className={`run-card ${expanded ? 'expanded' : ''}`}>
      <div className="run-card-head">
        <button className="run-summary" type="button" aria-expanded={expanded} onClick={onToggle}>
          <span>
            <span className="title">{caseName}</span>
            <span className="meta">{run.id}</span>
          </span>
          <span className={`pill ${run.status}`}>{runStatusLabel(run.status)}</span>
          <span className="run-metric">
            <small>开始</small>
            {run.startedAt ?? run.createdAt}
          </span>
          <span className="run-metric">
            <small>{item.kind === 'active' ? '已用时' : '耗时'}</small>
            {formatDuration(duration)}
          </span>
          <span className="run-counts">
            {Object.entries(counts)
              .filter(([, count]) => count > 0)
              .map(([nodeStatus, count]) => (
                <span className={`status-${nodeStatus}`} key={nodeStatus}>
                  {nodeStatus} {count}
                </span>
              ))}
          </span>
        </button>
        {item.kind === 'active' && onCancel ? (
          <button className="danger" data-testid="cancel-run" type="button" onClick={() => onCancel(run.id)}>
            停止
          </button>
        ) : null}
      </div>
      {expanded ? (
        <>
          <RunTreeView run={run} capabilities={capabilities} now={now} />
          {run.artifacts.length > 0 ? (
            <aside className="run-artifacts" data-testid="run-artifacts" aria-label="产物">
              <h3>
                产物 <span className="meta">{run.artifacts.length}</span>
              </h3>
              <ul>
                {runArtifactItems(run).map((item) => {
                  const Icon = ARTIFACT_ICONS[artifactKind(item.mediaType)];
                  return (
                    <li key={item.id}>
                      <a className="run-artifact" href={item.href} rel="noreferrer" target="_blank">
                        <Icon aria-hidden={true} className="run-artifact-icon" size={16} strokeWidth={2} />
                        <span>
                          <span className="title">{item.name}</span>
                          <span className="meta">{item.mediaType}</span>
                        </span>
                        <span className="run-artifact-open">打开</span>
                      </a>
                    </li>
                  );
                })}
              </ul>
            </aside>
          ) : null}
        </>
      ) : null}
    </article>
  );
}

const ARTIFACT_ICONS = {
  video: Film,
  image: Image,
  text: FileText,
  file: File,
};

function runStatusLabel(status: RunStatus): string {
  return {
    queued: '排队中',
    running: '执行中',
    canceling: '取消中',
    passed: '已通过',
    failed: '失败',
    canceled: '已取消',
  }[status];
}
