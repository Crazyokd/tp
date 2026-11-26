import { EventEmitter } from 'node:events';

import {
  appendRunArtifact,
  recordRunProgressEvent,
  type LiveRun,
  type RunArtifactEvent,
  type RunNodeProgressEvent,
} from '@tp/contract';
import { logger } from './log.ts';
import { createServerMetrics, type ServerMetrics } from './metrics.ts';

const log = logger('queue');

export function createRunQueue(options: { capacity?: number; metrics?: ServerMetrics } = {}) {
  const capacity = options.capacity ?? 1000;
  if (!Number.isInteger(capacity) || capacity < 1) throw new Error('run queue capacity must be a positive integer');
  const metrics = options.metrics ?? createServerMetrics();
  const runs: LiveRun[] = [];
  const events = new EventEmitter();

  function setDepth(): void {
    metrics.queueDepth.set(runs.length);
  }

  function recordProgress(id: string, event: RunNodeProgressEvent): LiveRun {
    const run = runs.find((candidate) => candidate.id === id);
    if (!run) throw new Error(`active run ${id} not found`);
    if (run.status !== 'running' && run.status !== 'canceling') {
      throw new Error(`active run ${id} is not running`);
    }
    recordRunProgressEvent(run, event);
    return run;
  }

  return {
    reserve(count: number): void {
      if (!Number.isInteger(count) || count < 1) throw new Error('run reserve count must be a positive integer');
      if (runs.length + count > capacity) {
        log.error('queue full', count, capacity);
        metrics.queueRejected.inc();
        throw new Error(`run queue capacity ${capacity} exceeded`);
      }
    },

    enqueue(input: LiveRun): LiveRun {
      if (input.status !== 'queued') throw new Error('new run must be queued');
      if (runs.some((run) => run.id === input.id)) throw new Error(`run ${input.id} is already active`);
      if (runs.length >= capacity) {
        log.error('queue full', input.id, capacity);
        metrics.queueRejected.inc();
        throw new Error(`run queue capacity ${capacity} exceeded`);
      }
      const run = clone(input);
      runs.push(run);
      const queued = clone(run);
      setDepth();
      log.info('queued', run.id);
      events.emit('available');
      return queued;
    },

    claimNext(): LiveRun | null {
      const run = runs.find((candidate) => candidate.status === 'queued');
      if (!run) return null;
      run.status = 'running';
      run.startedAt = new Date().toISOString();
      return clone(run);
    },

    applyProgress(id: string, event: RunNodeProgressEvent): LiveRun {
      return clone(recordProgress(id, event));
    },

    recordProgress(id: string, event: RunNodeProgressEvent): void {
      recordProgress(id, event);
    },

    applyArtifact(id: string, event: RunArtifactEvent): LiveRun {
      const run = runs.find((candidate) => candidate.id === id);
      if (!run) throw new Error(`active run ${id} not found`);
      if (run.status !== 'running' && run.status !== 'canceling') {
        throw new Error(`active run ${id} is not running`);
      }
      const next = appendRunArtifact({ revision: run.revision, artifacts: run.artifacts }, event);
      run.revision = next.revision;
      run.artifacts = next.artifacts;
      return clone(run);
    },

    takeIfQueued(id: string): LiveRun | null {
      const index = runs.findIndex((run) => run.id === id);
      if (index < 0) throw new Error(`active run ${id} not found`);
      if (runs[index]?.status !== 'queued') return null;
      const [run] = runs.splice(index, 1);
      if (!run) throw new Error(`active run ${id} not found`);
      setDepth();
      return clone(run);
    },

    markCanceling(id: string): LiveRun {
      const run = runs.find((candidate) => candidate.id === id);
      if (!run) throw new Error(`active run ${id} not found`);
      if (run.status !== 'running') throw new Error(`active run ${id} is not running`);
      run.status = 'canceling';
      return clone(run);
    },

    complete(id: string): LiveRun {
      const index = runs.findIndex((run) => run.id === id);
      if (index < 0) throw new Error(`active run ${id} not found`);
      const [run] = runs.splice(index, 1);
      if (!run) throw new Error(`active run ${id} not found`);
      setDepth();
      return clone(run);
    },

    statuses(): Pick<LiveRun, 'id' | 'status'>[] {
      return runs.map(({ id, status }) => ({ id, status }));
    },

    list(ids?: ReadonlySet<string>): LiveRun[] {
      return runs.filter((run) => !ids || ids.has(run.id)).map(clone);
    },

    get(id: string): LiveRun {
      const run = runs.find((candidate) => candidate.id === id);
      if (!run) throw new Error(`active run ${id} not found`);
      return clone(run);
    },

    onAvailable(listener: () => void): () => void {
      events.on('available', listener);
      return () => events.off('available', listener);
    },
  };
}

export type RunQueue = ReturnType<typeof createRunQueue>;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
