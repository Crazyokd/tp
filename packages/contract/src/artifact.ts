import { posix } from 'node:path';

import type { Artifact } from './types.ts';

export type RunArtifactSnapshot = {
  revision: number;
  artifacts: Artifact[];
};

export type RunArtifactEvent = {
  revision: number;
  artifact: Artifact;
};

export function resolveRunArtifactPath(path: string): string {
  if (typeof path !== 'string' || path.trim() === '') throw new Error('artifact path must be a relative path');
  const trimmed = path.trim();
  if (trimmed.startsWith('/') || /^[A-Za-z]:[\\/]/.test(trimmed)) {
    throw new Error('artifact path must be a relative path');
  }
  const normalized = posix.normalize(trimmed.replaceAll('\\', '/'));
  if (normalized === '..' || normalized.startsWith('../') || normalized.startsWith('/')) {
    throw new Error(`artifact path escapes the resource root: ${path}`);
  }
  return normalized;
}

export function appendRunArtifact(snapshot: RunArtifactSnapshot, event: RunArtifactEvent): RunArtifactSnapshot {
  const expected = snapshot.revision + 1;
  if (!Number.isInteger(event.revision) || event.revision !== expected) {
    throw new Error(`expected revision ${expected}, received ${event.revision}`);
  }
  if (snapshot.artifacts.some((item) => item.id === event.artifact.id)) {
    throw new Error(`artifact ${event.artifact.id} is already recorded`);
  }
  return {
    revision: event.revision,
    artifacts: [...snapshot.artifacts, event.artifact],
  };
}
