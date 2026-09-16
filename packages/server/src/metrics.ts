import { createMetrics, type Counter, type Gauge, type Histogram } from '@tp/metrics';

export type ServerMetrics = {
  httpRequests: Counter;
  httpDuration: Histogram;
  cases: Counter;
  runs: Counter;
  runDuration: Histogram;
  queueDepth: Gauge;
  queueRejected: Counter;
  adaptersLoaded: Counter;
  workersBusy: Gauge;
  workersIdle: Gauge;
  workerFatals: Counter;
  cancels: Counter;
  collect: () => ReturnType<ReturnType<typeof createMetrics>['collect']>;
};

export function createServerMetrics(): ServerMetrics {
  const metrics = createMetrics();
  return {
    httpRequests: metrics.counter('http_requests_total', { help: 'HTTP API requests' }),
    httpDuration: metrics.histogram('http_request_seconds', {
      help: 'HTTP API latency',
      buckets: [0.005, 0.025, 0.1, 0.5, 2, 10],
    }),
    cases: metrics.counter('cases_total', { help: 'Case mutations' }),
    runs: metrics.counter('runs_total', { help: 'Finished runs' }),
    runDuration: metrics.histogram('run_seconds', {
      help: 'Run duration from claim to persist',
      buckets: [0.1, 1, 5, 30, 120],
    }),
    queueDepth: metrics.gauge('run_queue_depth', { help: 'Live runs in the memory queue' }),
    queueRejected: metrics.counter('run_queue_rejected_total', { help: 'Runs rejected because the queue was full' }),
    adaptersLoaded: metrics.counter('adapters_loaded_total', { help: 'Adapter modules loaded' }),
    workersBusy: metrics.gauge('workers_busy', { help: 'Worker threads executing a run' }),
    workersIdle: metrics.gauge('workers_idle', { help: 'Idle worker threads' }),
    workerFatals: metrics.counter('worker_fatals_total', { help: 'Worker thread fatals' }),
    cancels: metrics.counter('run_cancels_total', { help: 'Accepted run cancel requests' }),
    collect: () => metrics.collect(),
  };
}

export function recordHttp(metrics: ServerMetrics, operation: string, status: number, started: number): void {
  metrics.httpRequests.inc(1, { operation, code: String(status) });
  metrics.httpDuration.observe((performance.now() - started) / 1000, { operation });
}
