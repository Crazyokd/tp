import { File, FileText, Film, Image } from 'lucide-react';
import { useMemo } from 'react';

import type { CatalogCapability, RunStatus, TestCase } from '@tp/contract';
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
  runs: UnifiedRun[];
  cases: readonly TestCase[];
  capabilities: readonly CatalogCapability[];
  expandedRunId: string | null;
  now: number;
  onToggle: (item: UnifiedRun) => void;
  onCancel?: (runId: string) => void;
};

export function RunsPage({ runs, cases, capabilities, expandedRunId, now, onToggle, onCancel }: Props) {
  return (
    <section className="runs-section" data-testid="runs-page">
      <div className="section-head">
        <h2>Runs List</h2>
        <span className="meta">{runs.length} items</span>
      </div>
      <div className="runs-list">
        {runs.length === 0 ? (
          <div className="empty">暂无 Run</div>
        ) : (
          runs.map((item) => (
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
        )}
      </div>
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
