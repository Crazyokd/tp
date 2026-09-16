import type { Run, TestCase, WorkerSlot } from '@tp/contract';

const STATE_LABEL: Record<WorkerSlot['state'], string> = {
  starting: '启动中',
  idle: '空闲',
  running: '执行中',
  finalizing: '收尾中',
  failed: '失败',
};

type Props = {
  workers: WorkerSlot[];
  runs: Run[];
  cases: readonly TestCase[];
  onOpenRun: (runId: string) => void;
};

export function WorkersPage({ workers, runs, cases, onOpenRun }: Props) {
  const runsById = new Map(runs.map((run) => [run.id, run]));
  const casesById = new Map(cases.map((item) => [item.id, item]));
  return (
    <section className="workers-page" data-testid="workers-page">
      <div className="section-head">
        <div>
          <h2>Workers</h2>
          <div className="meta">固定线程池快照。不能指定某个 Worker 执行 Run。</div>
        </div>
        <span className="meta">{workers.length} slots</span>
      </div>
      <div className="worker-grid">
        {workers.length === 0 ? (
          <div className="empty">暂无 Worker</div>
        ) : (
          workers.map((worker) => {
            const run = worker.runId ? runsById.get(worker.runId) : undefined;
            return (
              <article className="item worker-card" data-worker-id={worker.id} key={worker.id}>
                <div className="row">
                  <div className="title">{worker.id}</div>
                  <span className={`pill ${worker.state}`}>{STATE_LABEL[worker.state]}</span>
                </div>
                {worker.runId ? (
                  <>
                    <div className="meta">Run: {worker.runId}</div>
                    <div className="meta">{run ? (casesById.get(run.caseId)?.name ?? run.caseId) : '未知 Case'}</div>
                    <div className="toolbar">
                      <button type="button" onClick={() => onOpenRun(worker.runId!)}>
                        查看 Run
                      </button>
                    </div>
                  </>
                ) : (
                  <div className="meta">未分配 Run</div>
                )}
              </article>
            );
          })
        )}
      </div>
    </section>
  );
}
