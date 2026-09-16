import { createMetrics, type Counter } from '@tp/metrics';

export type BrowserMetrics = {
  sessions: Counter;
  cleanups: Counter;
  ticks: Counter;
  collect: () => ReturnType<ReturnType<typeof createMetrics>['collect']>;
};

function createBrowserMetrics(): BrowserMetrics {
  const metrics = createMetrics();
  return {
    sessions: metrics.counter('browser_sessions_total', { help: 'Browser sessions opened' }),
    cleanups: metrics.counter('browser_session_cleanups_total', { help: 'Browser session cleanups' }),
    ticks: metrics.counter('browser_ticks_total', { help: 'Browser leaf ticks' }),
    collect: () => metrics.collect(),
  };
}

let current = createBrowserMetrics();

export function browserMetrics(): BrowserMetrics {
  return current;
}

export function resetBrowserMetrics(): BrowserMetrics {
  current = createBrowserMetrics();
  return current;
}
