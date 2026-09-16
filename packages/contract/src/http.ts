export const apiPaths = {
  adapters: '/api/adapters',
  cases: '/api/cases',
  runs: '/api/runs',
  workers: '/api/workers',
  metrics: '/api/metrics',
} as const;

export function adapterPath(id: string): string {
  return `/api/adapters/${id}`;
}

export function casePath(id: string): string {
  return `/api/cases/${id}`;
}

export function runPath(id: string): string {
  return `/api/runs/${id}`;
}

export function runCancelPath(id: string): string {
  return `/api/runs/${id}/cancel`;
}

export function runArtifactPath(runId: string, artifactId: string): string {
  return `/api/runs/${runId}/artifacts/${artifactId}`;
}

export function workerPath(id: string): string {
  return `/api/workers/${id}`;
}
