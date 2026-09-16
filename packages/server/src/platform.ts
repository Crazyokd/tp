import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  createRunTree,
  failedRunError,
  finalizeRunTree,
  httpCaseSchema,
  httpRunSchema,
  type JsonObject,
  type LiveRun,
  type Run,
  type RunStatus,
  type TestCase,
} from '@tp/contract';
import { z } from 'zod';
import { createAdapterRegistry, type AdapterRegistry } from './adapter-registry.ts';
import { logger } from './log.ts';
import { validateDefinition } from './definition.ts';
import { HttpError } from './http-error.ts';
import { createServerMetrics, type ServerMetrics } from './metrics.ts';
import { openRunArtifactStore } from './run-artifacts.ts';
import { createRunQueue, type RunQueue } from './run-queue.ts';

const log = logger('platform');
const FINISHED_STATUSES = new Set<RunStatus>(['passed', 'failed', 'canceled']);
const LIVE_STATUSES = new Set<RunStatus>(['queued', 'running', 'canceling']);
const storedPlatformSchema = z
  .object({
    cases: z.array(z.unknown()),
    runs: z.array(z.unknown()),
  })
  .strict();

type PlatformData = {
  cases: TestCase[];
  runs: Run[];
};

type PlatformOptions = {
  registry?: AdapterRegistry;
  runQueue?: RunQueue;
  metrics?: ServerMetrics;
  workspaceRoot?: string;
};

export async function createPlatform(filePath = 'data/tp.json', options: PlatformOptions = {}) {
  const data = await load(filePath);
  const registry = options.registry ?? createAdapterRegistry();
  const metrics = options.metrics ?? createServerMetrics();
  const runQueue = options.runQueue ?? createRunQueue({ metrics });
  const workspaceRoot = options.workspaceRoot;
  const finishing = new Set<string>();
  let writes = Promise.resolve();

  async function writeSnapshot(): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`);
      await rename(temporary, filePath);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  function mutate<T>(change: () => T): Promise<T> {
    const operation = writes.then(async () => {
      const before = clone(data);
      try {
        const result = change();
        await writeSnapshot();
        return result;
      } catch (error) {
        data.cases = before.cases;
        data.runs = before.runs;
        throw error;
      }
    });
    writes = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  function hasLiveRuns(caseId: string): boolean {
    return runQueue.list().some((run) => run.caseId === caseId && LIVE_STATUSES.has(run.status));
  }

  async function persistCanceled(run: LiveRun): Promise<Run> {
    const finalized = finalizeRunTree({ revision: run.revision, tree: run.tree }, 'canceled');
    const { error: _error, ...rest } = run;
    const record = toPublicRun({
      ...rest,
      status: 'canceled',
      finishedAt: new Date().toISOString(),
      revision: finalized.revision,
      tree: finalized.tree,
    });
    return mutate(() => {
      data.runs.push(record);
      return clone(record);
    });
  }

  return {
    async listCases(): Promise<TestCase[]> {
      await writes;
      return clone(data.cases);
    },

    async getCase(id: string): Promise<TestCase> {
      await writes;
      return clone(findCase(data, id));
    },

    async createCase(input: unknown): Promise<TestCase> {
      const body = objectInput(input);
      const now = new Date().toISOString();
      const item: TestCase = {
        id: randomUUID(),
        name: requiredString(body.name, 'name'),
        definition: validatedDefinition(body.definition, registry),
        createdAt: now,
        updatedAt: now,
      };
      const created = await mutate(() => {
        assertUniqueName(data, item.name);
        data.cases.push(item);
        return clone(item);
      });
      log.info('created case', created.id, created.name);
      metrics.cases.inc(1, { action: 'created' });
      return created;
    },

    async updateCase(id: string, input: unknown): Promise<TestCase> {
      const body = objectInput(input);
      const name = requiredString(body.name, 'name');
      const definition = validatedDefinition(body.definition, registry);
      const updated = await mutate(() => {
        const item = findCase(data, id);
        if (hasLiveRuns(id)) throw new HttpError('conflict', `case ${id} has live runs`);
        assertUniqueName(data, name, id);
        item.name = name;
        item.definition = definition;
        item.updatedAt = new Date().toISOString();
        return clone(item);
      });
      log.info('updated case', updated.id, updated.name);
      metrics.cases.inc(1, { action: 'updated' });
      return updated;
    },

    async deleteCase(id: string): Promise<void> {
      await mutate(() => {
        findCase(data, id);
        if (hasLiveRuns(id)) throw new HttpError('conflict', `case ${id} has live runs`);
        data.cases = data.cases.filter((item) => item.id !== id);
      });
      log.info('deleted case', id);
      metrics.cases.inc(1, { action: 'deleted' });
    },

    hasLiveRuns,

    async listRuns(query: { status?: RunStatus[] } = {}): Promise<Run[]> {
      await writes;
      const items = [...runQueue.list().map(toPublicRun), ...clone(data.runs)];
      if (!query.status) return items;
      const allowed = new Set(query.status);
      return items.filter((run) => allowed.has(run.status));
    },

    async getRun(id: string): Promise<Run> {
      await writes;
      const live = runQueue.list().find((run) => run.id === id);
      if (live) return toPublicRun(live);
      const persisted = data.runs.find((run) => run.id === id);
      if (persisted) return clone(persisted);
      throw new HttpError('not_found', `run ${id} not found`);
    },

    async getRunArtifact(
      runId: string,
      artifactId: string,
    ): Promise<{ bytes: Buffer; name: string; mediaType: string }> {
      const run = await this.getRun(runId);
      if (!run.artifacts.some((item) => item.id === artifactId)) {
        throw new HttpError('not_found', `artifact ${artifactId} not found`);
      }
      if (!workspaceRoot) throw new Error('workspaceRoot is required');
      try {
        return await openRunArtifactStore(join(workspaceRoot, runId)).readArtifact(artifactId);
      } catch {
        throw new HttpError('not_found', `artifact ${artifactId} not found`);
      }
    },

    async createRun(input: unknown): Promise<Run> {
      await writes;
      const body = objectInput(input);
      const sourceCase = findCase(data, requiredString(body.caseId, 'caseId'));
      const definition = validatedDefinition(sourceCase.definition, registry);
      const createdAt = new Date().toISOString();
      const run: LiveRun = {
        id: randomUUID(),
        caseId: sourceCase.id,
        status: 'queued',
        createdAt,
        startedAt: null,
        finishedAt: null,
        revision: 0,
        tree: createRunTree(definition),
        artifacts: [],
        definition,
      };
      const created = toPublicRun(runQueue.enqueue(run));
      log.info('created run', created.id, 'case', created.caseId);
      return created;
    },

    async cancelRun(id: string): Promise<Run> {
      await writes;
      const live = runQueue.list().find((run) => run.id === id);
      if (live?.status === 'queued') {
        const record = await persistCanceled(live);
        runQueue.complete(id);
        log.info('canceled run', id);
        metrics.cancels.inc(1, { phase: 'queued' });
        metrics.runs.inc(1, { status: 'canceled' });
        return record;
      }
      if (live?.status === 'running') {
        const canceling = toPublicRun(runQueue.markCanceling(id));
        log.info('canceling run', id);
        metrics.cancels.inc(1, { phase: 'running' });
        return canceling;
      }
      if (live?.status === 'canceling') return toPublicRun(live);
      const persisted = data.runs.find((run) => run.id === id);
      if (persisted) throw new HttpError('conflict', `run ${id} is already ${persisted.status}`);
      throw new HttpError('not_found', `run ${id} not found`);
    },

    async finishRun(id: string, input: unknown): Promise<Run> {
      const body = objectInput(input);
      const status = body.status;
      if (typeof status !== 'string' || !FINISHED_STATUSES.has(status as RunStatus)) {
        throw new HttpError('invalid', `invalid run status ${String(status)}`);
      }
      if (finishing.has(id)) throw new Error(`run ${id} is already finishing`);
      finishing.add(id);
      try {
        const active = findLive(runQueue, id);
        if (active.startedAt == null) throw new Error(`run ${id} has not started`);
        const suppliedError =
          typeof body.error === 'string' && body.error.trim().length > 0 ? body.error.trim() : undefined;
        let error = suppliedError;
        if (status === 'failed' && error === undefined) {
          try {
            error = failedRunError(active.tree);
          } catch (cause) {
            throw new HttpError(
              'invalid',
              cause instanceof Error ? cause.message : 'failed run has no failed leaf attempt',
            );
          }
        }
        const snapshot = { revision: active.revision, tree: active.tree };
        const finalized =
          status === 'failed'
            ? finalizeRunTree(snapshot, 'failed', error)
            : finalizeRunTree(snapshot, status as RunStatus);
        const run = toPublicRun({
          ...active,
          status: status as RunStatus,
          revision: finalized.revision,
          tree: finalized.tree,
          startedAt: active.startedAt,
          finishedAt: new Date().toISOString(),
          ...(status === 'failed' ? { error } : {}),
        });
        const record = await mutate(() => {
          data.runs.push(run);
          return clone(run);
        });
        runQueue.complete(id);
        log.info('finished run', record.id, record.status);
        metrics.runs.inc(1, { status: record.status });
        if (active.startedAt && record.finishedAt) {
          const seconds = (Date.parse(record.finishedAt) - Date.parse(active.startedAt)) / 1000;
          if (Number.isFinite(seconds) && seconds >= 0) {
            metrics.runDuration.observe(seconds, { status: record.status });
          }
        }
        return record;
      } finally {
        finishing.delete(id);
      }
    },
  };
}

async function load(filePath: string): Promise<PlatformData> {
  try {
    const parsed = storedPlatformSchema.parse(JSON.parse(await readFile(filePath, 'utf8')));
    return {
      cases: parsed.cases.map(parseStoredCase),
      runs: parsed.runs.map(parseStoredRun),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { cases: [], runs: [] };
    throw error;
  }
}

function parseStoredCase(value: unknown): TestCase {
  return httpCaseSchema.parse(value);
}

function parseStoredRun(value: unknown): Run {
  const record = httpRunSchema.parse(value);
  if (!FINISHED_STATUSES.has(record.status) || record.finishedAt == null) {
    throw new Error('stored run status is invalid');
  }
  return record;
}

function findCase(data: PlatformData, id: string): TestCase {
  const item = data.cases.find((candidate) => candidate.id === id);
  if (!item) throw new HttpError('not_found', `case ${id} not found`);
  return item;
}

function findLive(runQueue: RunQueue, id: string): LiveRun {
  try {
    return runQueue.get(id);
  } catch {
    throw new HttpError('not_found', `run ${id} not found`);
  }
}

function assertUniqueName(data: PlatformData, name: string, exceptId?: string): void {
  if (data.cases.some((item) => item.name === name && item.id !== exceptId)) {
    throw new HttpError('conflict', `case name ${name} already exists`);
  }
}

function validatedDefinition(definition: unknown, registry: AdapterRegistry) {
  try {
    return validateDefinition(definition, registry);
  } catch (error) {
    throw new HttpError('invalid', error instanceof Error ? error.message : 'invalid definition');
  }
}

function objectInput(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError('invalid', 'request body must be an object');
  }
  return value as JsonObject;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new HttpError('invalid', `${field} is required`);
  return value.trim();
}

function toPublicRun(run: LiveRun | Run): Run {
  const { definition: _definition, ...rest } = run as LiveRun;
  return httpRunSchema.parse(clone(rest));
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
