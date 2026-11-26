export const apiPaths = {
  adapters: '/api/adapters',
  cases: '/api/cases',
  groups: '/api/groups',
  batches: '/api/batches',
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

export function runEventsPath(id: string): string {
  return `/api/runs/${id}/events`;
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

export function groupPath(id: string): string {
  return `/api/groups/${id}`;
}

export function batchPath(id: string): string {
  return `/api/batches/${id}`;
}

export function batchCancelPath(id: string): string {
  return `/api/batches/${id}/cancel`;
}
