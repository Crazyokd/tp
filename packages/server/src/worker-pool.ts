import { Worker } from 'node:worker_threads';

import type { AdapterRegistry } from './adapter-registry.ts';
import { logger } from './log.ts';
import { createServerMetrics, type ServerMetrics } from './metrics.ts';
import type { RunQueue } from './run-queue.ts';
import type { RunArtifactEvent, RunNodeProgressEvent, WorkerSlot } from '@tp/contract';
import type { WorkerThreadResult } from './worker-thread.ts';

type WorkerPoolOptions = {
  size: number;
  registry: AdapterRegistry;
  runQueue: RunQueue;
  workspaceRoot: string;
  onProgress: (runId: string, event: RunNodeProgressEvent) => unknown;
  onResult: (runId: string, result: WorkerThreadResult) => Promise<void>;
  onRunFatal?: (runId: string, result: WorkerThreadResult) => Promise<void>;
  onFatal?: (error: Error) => void;
  sessionCleanupTimeoutMs?: number;
  treeTickIntervalMs?: number;
  workerFactory?: (url: URL) => Worker;
  metrics?: ServerMetrics;
};

export type ThreadMessage =
  | { type: 'ready' }
  | { type: 'progress'; runId: string; event: RunNodeProgressEvent }
  | { type: 'artifact'; runId: string; event: RunArtifactEvent }
  | { type: 'result'; runId: string; result: WorkerThreadResult }
  | { type: 'fatal'; runId: string; error: string };

const log = logger('worker');

type WorkerState = 'starting' | 'idle' | 'running' | 'finalizing' | 'failed';
type TerminalClaim = 'result' | 'fatal';

export function createWorkerPool(options: WorkerPoolOptions) {
  if (!Number.isInteger(options.size) || options.size < 1)
    throw new Error('worker pool size must be a positive integer');

  const metrics = options.metrics ?? createServerMetrics();
  const workers = new Set<Worker>();
  const idle = new Set<Worker>();
  const failed = new WeakSet<Worker>();
  const failing = new WeakSet<Worker>();
  const states = new WeakMap<Worker, WorkerState>();
  const slotIds = new WeakMap<Worker, string>();
  const assigned = new WeakMap<Worker, string>();
  let nextSlot = 1;
  const terminalClaims = new WeakMap<Worker, TerminalClaim>();
  const pendingHostErrors = new WeakMap<Worker, Error>();
  let started = false;
  let closing = false;
  let unsubscribe: (() => void) | undefined;

  function refreshWorkerGauges(): void {
    let busy = 0;
    let idleCount = 0;
    for (const worker of workers) {
      const state = states.get(worker);
      if (state === 'running' || state === 'finalizing') busy += 1;
      if (state === 'idle') idleCount += 1;
    }
    metrics.workersBusy.set(busy);
    metrics.workersIdle.set(idleCount);
  }

  function assign(worker: Worker): void {
    if (failing.has(worker) || failed.has(worker)) return;
    const run = options.runQueue.claimNext();
    if (!run) {
      states.set(worker, 'idle');
      assigned.delete(worker);
      idle.add(worker);
      refreshWorkerGauges();
      return;
    }
    idle.delete(worker);
    states.set(worker, 'running');
    assigned.set(worker, run.id);
    refreshWorkerGauges();
    log.info('assigned', slotIds.get(worker), run.id);
    worker.postMessage({
      type: 'run',
      run,
      adapters: options.registry.listAdapters(),
      workspaceRoot: options.workspaceRoot,
      sessionCleanupTimeoutMs: options.sessionCleanupTimeoutMs,
      treeTickIntervalMs: options.treeTickIntervalMs,
    });
  }

  function dispatch(): void {
    for (const worker of [...idle]) assign(worker);
  }

  function hostFatal(worker: Worker, error: Error): void {
    if (closing || failed.has(worker)) return;
    failed.add(worker);
    states.set(worker, 'failed');
    idle.delete(worker);
    metrics.workerFatals.inc();
    refreshWorkerGauges();
    log.error('fatal', slotIds.get(worker), error);
    options.onFatal?.(error);
    if (!options.onFatal) {
      process.nextTick(() => {
        throw error;
      });
    }
  }

  function protocolError(worker: Worker, detail: string): void {
    beginUnexpectedFatal(worker, new Error(`worker protocol error: ${detail}`));
  }

  function assertAssigned(worker: Worker, runId: string, type: string): boolean {
    const state = states.get(worker);
    const expectedRunId = assigned.get(worker);
    if (state !== 'running') {
      protocolError(worker, `${type} received while ${state ?? 'untracked'}`);
      return false;
    }
    if (!expectedRunId || runId !== expectedRunId) {
      protocolError(worker, `${type} run ${runId} does not match assigned run ${expectedRunId ?? 'none'}`);
      return false;
    }
    return true;
  }

  function handleMessage(worker: Worker, message: ThreadMessage): void {
    if (message.type === 'ready') {
      if (states.get(worker) !== 'starting') {
        protocolError(worker, `ready received while ${states.get(worker) ?? 'untracked'}`);
        return;
      }
      assign(worker);
      return;
    }
    if (message.type === 'progress') {
      if (!assertAssigned(worker, message.runId, 'progress')) return;
      try {
        const returned = options.onProgress(message.runId, message.event);
        if (isThenable(returned)) {
          void Promise.resolve(returned).catch(() => undefined);
          throw new Error('onProgress must be synchronous');
        }
      } catch (error) {
        beginUnexpectedFatal(worker, asError(error));
      }
      return;
    }
    if (message.type === 'artifact') {
      if (!assertAssigned(worker, message.runId, 'artifact')) return;
      try {
        options.runQueue.applyArtifact(message.runId, message.event);
      } catch (error) {
        beginUnexpectedFatal(worker, asError(error));
      }
      return;
    }
    if (message.type === 'fatal') {
      if (!assertAssigned(worker, message.runId, 'fatal')) return;
      if (typeof message.error !== 'string' || message.error.trim() === '') {
        protocolError(worker, 'fatal error must be a non-empty string');
        return;
      }
      states.set(worker, 'finalizing');
      failing.add(worker);
      terminalClaims.set(worker, 'fatal');
      refreshWorkerGauges();
      void finalizeFatal(worker, message.runId, new Error(message.error));
      return;
    }
    if (message.type !== 'result') {
      protocolError(worker, `unknown message type ${String((message as { type?: string }).type)}`);
      return;
    }
    if (!assertAssigned(worker, message.runId, 'result')) return;
    states.set(worker, 'finalizing');
    terminalClaims.set(worker, 'result');
    refreshWorkerGauges();
    void finalizeResult(worker, message.runId, message.result);
  }

  async function finalizeResult(worker: Worker, runId: string, result: WorkerThreadResult): Promise<void> {
    let resultError: Error | undefined;
    try {
      await options.onResult(runId, result);
      log.info('finished', slotIds.get(worker), runId, result.status);
    } catch (error) {
      resultError = asError(error);
    }
    assigned.delete(worker);
    const pendingError = pendingHostErrors.get(worker);
    if (resultError || pendingError) {
      const error =
        resultError && pendingError
          ? new AggregateError([resultError, pendingError], `${resultError.message}; ${pendingError.message}`)
          : (resultError ?? pendingError!);
      hostFatal(worker, error);
      return;
    }
    if (failing.has(worker) || failed.has(worker) || closing) return;
    assign(worker);
  }

  async function finalizeFatal(worker: Worker, runId: string, error: Error): Promise<void> {
    let hostError = error;
    try {
      const live = options.runQueue.get(runId);
      await (options.onRunFatal ?? options.onResult)(runId, {
        status: 'failed',
        tree: live.tree,
        revision: live.revision,
        artifacts: live.artifacts,
        error: error.message,
      });
    } catch (persistenceError) {
      hostError = new AggregateError(
        [error, asError(persistenceError)],
        `${error.message}; failed to persist fatal run: ${asError(persistenceError).message}`,
      );
    }
    hostFatal(worker, hostError);
  }

  function beginUnexpectedFatal(worker: Worker, error: Error): void {
    if (closing || failed.has(worker)) return;
    if (states.get(worker) === 'finalizing') {
      if (terminalClaims.get(worker) === 'result' && !pendingHostErrors.has(worker)) {
        failing.add(worker);
        pendingHostErrors.set(worker, error);
      }
      return;
    }
    if (failing.has(worker)) return;
    failing.add(worker);
    const runId = assigned.get(worker);
    states.set(worker, 'finalizing');
    if (runId) {
      terminalClaims.set(worker, 'fatal');
      void finalizeFatal(worker, runId, error);
      return;
    }
    hostFatal(worker, error);
  }

  function spawn(): void {
    const url = new URL('./worker-thread.ts', import.meta.url);
    const worker = options.workerFactory?.(url) ?? new Worker(url);
    workers.add(worker);
    slotIds.set(worker, `worker-${nextSlot}`);
    nextSlot += 1;
    states.set(worker, 'starting');
    worker.on('message', (message: ThreadMessage) => {
      handleMessage(worker, message);
    });
    worker.on('error', (error) => beginUnexpectedFatal(worker, asError(error)));
    worker.on('exit', (code) => {
      workers.delete(worker);
      idle.delete(worker);
      if (!closing) beginUnexpectedFatal(worker, new Error(`worker thread exited unexpectedly with code ${code}`));
    });
  }

  return {
    start(): void {
      if (started) return;
      started = true;
      unsubscribe = options.runQueue.onAvailable(dispatch);
      for (let index = 0; index < options.size; index += 1) spawn();
      log.info('pool started', options.size);
    },

    async close(): Promise<void> {
      closing = true;
      unsubscribe?.();
      await Promise.all([...workers].map((worker) => worker.terminate()));
      workers.clear();
      idle.clear();
      metrics.workersBusy.set(0);
      metrics.workersIdle.set(0);
      log.info('pool closed');
    },

    size(): number {
      return workers.size;
    },

    list(): WorkerSlot[] {
      return [...workers]
        .map((worker) => ({
          id: slotIds.get(worker) ?? 'worker-unknown',
          state: states.get(worker) ?? 'starting',
          runId: assigned.get(worker) ?? null,
        }))
        .sort((left, right) => left.id.localeCompare(right.id, 'en'));
    },

    cancel(runId: string): boolean {
      for (const worker of workers) {
        if (assigned.get(worker) === runId && states.get(worker) === 'running') {
          worker.postMessage({ type: 'cancel', runId });
          log.info('cancel sent', runId);
          return true;
        }
      }
      return false;
    },
  };
}

export type WorkerPool = ReturnType<typeof createWorkerPool>;

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as PromiseLike<unknown>).then === 'function'
  );
}
