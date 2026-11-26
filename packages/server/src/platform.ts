import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';

import {
  createRunTree,
  failedRunError,
  finalizeRunTree,
  httpCaseSchema,
  httpCaseWriteSchema,
  httpGroupSchema,
  httpGroupWriteSchema,
  httpBatchCreateSchema,
  httpBatchImportSchema,
  httpBatchMetadataSchema,
  httpRunSchema,
  resolveRunArtifactPath,
  paginate,
  type PageQuery,
  type Batch,
  type JsonObject,
  type LiveRun,
  type Run,
  type RunStatus,
  type TestCase,
  type TestGroup,
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
const storedBatchSchema = httpBatchMetadataSchema
  .extend({
    id: z.string().trim().min(1),
    createdAt: z.string(),
    runs: z.array(httpRunSchema).min(1),
  })
  .strict();

type StoredBatch = z.infer<typeof storedBatchSchema>;

const storedPlatformSchema = z
  .object({
    cases: z.array(z.unknown()),
    groups: z.array(httpGroupSchema),
    batches: z.array(storedBatchSchema),
  })
  .strict();

type PlatformData = {
  cases: TestCase[];
  groups: TestGroup[];
  batches: StoredBatch[];
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

  function mutate<T>(change: () => T | Promise<T>): Promise<T> {
    const operation = writes.then(async () => {
      const before = clone(data);
      try {
        const result = await change();
        await writeSnapshot();
        return result;
      } catch (error) {
        data.cases = before.cases;
        data.groups = before.groups;
        data.batches = before.batches;
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
    return data.batches.some((batch) =>
      batch.runs.some((run) => run.caseId === caseId && LIVE_STATUSES.has(run.status)),
    );
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
      replaceRun(record);
      return clone(record);
    });
  }

  function replaceRun(run: Run): void {
    const batch = findBatch(data, run.batchId);
    const index = batch.runs.findIndex((item) => item.id === run.id);
    if (index < 0) throw new HttpError('not_found', `run ${run.id} not found`);
    batch.runs[index] = run;
  }

  function publicBatch(
    batch: StoredBatch,
    live = new Map(runQueue.list(new Set(batch.runs.map((run) => run.id))).map((run) => [run.id, run])),
  ): Batch {
    return summarizeBatch(
      batch,
      batch.runs.map((run) => toPublicRun(live.get(run.id) ?? run)),
    );
  }

  let interrupted = false;
  for (const batch of data.batches) {
    for (const run of batch.runs) {
      if (!LIVE_STATUSES.has(run.status)) continue;
      const error = 'server restarted before run completed';
      const finalized = finalizeRunTree({ revision: run.revision, tree: run.tree }, 'failed', error);
      Object.assign(run, finalized, { status: 'failed', finishedAt: new Date().toISOString(), error });
      interrupted = true;
    }
  }
  if (interrupted) await writeSnapshot();

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
      const body = parseCaseWrite(input);
      const now = new Date().toISOString();
      const item: TestCase = {
        id: randomUUID(),
        name: requiredString(body.name, 'name'),
        description: requiredString(body.description, 'description'),
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
      const body = parseCaseWrite(input);
      const name = requiredString(body.name, 'name');
      const description = requiredString(body.description, 'description');
      const definition = validatedDefinition(body.definition, registry);
      const updated = await mutate(() => {
        const item = findCase(data, id);
        if (hasLiveRuns(id)) throw new HttpError('conflict', `case ${id} has live runs`);
        assertUniqueName(data, name, id);
        item.name = name;
        item.description = description;
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
        const references = data.groups.filter((group) => group.caseIds.includes(id));
        if (references.length > 0) {
          throw new HttpError(
            'conflict',
            `case ${id} is referenced by groups: ${references.map((group) => group.name).join(', ')}`,
          );
        }
        data.cases = data.cases.filter((item) => item.id !== id);
      });
      log.info('deleted case', id);
      metrics.cases.inc(1, { action: 'deleted' });
    },

    async listGroups(): Promise<TestGroup[]> {
      await writes;
      return clone(data.groups);
    },

    async getGroup(id: string): Promise<TestGroup> {
      await writes;
      return clone(findGroup(data, id));
    },

    async createGroup(input: unknown): Promise<TestGroup> {
      const body = httpGroupWriteSchema.parse(input);
      return mutate(() => {
        assertGroupReferences(data, body.caseIds);
        assertUniqueGroupName(data, body.name);
        const now = new Date().toISOString();
        const group: TestGroup = { ...body, id: randomUUID(), createdAt: now, updatedAt: now };
        data.groups.push(group);
        return clone(group);
      });
    },

    async updateGroup(id: string, input: unknown): Promise<TestGroup> {
      const body = httpGroupWriteSchema.parse(input);
      return mutate(() => {
        const group = findGroup(data, id);
        assertGroupReferences(data, body.caseIds);
        assertUniqueGroupName(data, body.name, id);
        Object.assign(group, body, { updatedAt: new Date().toISOString() });
        return clone(group);
      });
    },

    async deleteGroup(id: string): Promise<void> {
      await mutate(() => {
        findGroup(data, id);
        data.groups = data.groups.filter((group) => group.id !== id);
      });
    },

    hasLiveRuns,

    async listBatches(query: PageQuery = {}): Promise<{ items: Batch[]; total: number }> {
      await writes;
      const page = paginate(data.batches.toReversed(), query);
      const ids = new Set(page.items.flatMap((batch) => batch.runs.map((run) => run.id)));
      const live = new Map(runQueue.list(ids).map((run) => [run.id, run]));
      return { items: page.items.map((batch) => publicBatch(batch, live)), total: page.total };
    },

    async getBatch(id: string): Promise<Batch> {
      await writes;
      return publicBatch(findBatch(data, id));
    },

    async pruneBatches(finishedBefore: number): Promise<number> {
      return mutate(async () => {
        const expired = data.batches.filter((batch) => {
          const summary = publicBatch(batch);
          return summary.finishedAt !== null && Date.parse(summary.finishedAt) < finishedBefore;
        });
        if (workspaceRoot !== undefined) {
          for (const batch of expired) {
            for (const run of batch.runs) {
              if (run.id === '.' || run.id === '..' || /[/\\]/.test(run.id)) {
                throw new Error(`invalid run resource root: ${run.id}`);
              }
              await rm(join(workspaceRoot, run.id), { recursive: true, force: true });
            }
          }
        }
        const ids = new Set(expired.map((batch) => batch.id));
        data.batches = data.batches.filter((batch) => !ids.has(batch.id));
        return expired.length;
      });
    },

    async listRuns(query: PageQuery & { status?: RunStatus[] } = {}): Promise<{ items: Run[]; total: number }> {
      await writes;
      const statuses = new Map(runQueue.statuses().map((run) => [run.id, run.status]));
      const allowed = query.status && new Set(query.status);
      const items = data.batches
        .toReversed()
        .flatMap((batch) => batch.runs.filter((run) => !allowed || allowed.has(statuses.get(run.id) ?? run.status)));
      const page = paginate(items, query);
      const live = new Map(runQueue.list(new Set(page.items.map((run) => run.id))).map((run) => [run.id, run]));
      return { items: page.items.map((run) => toPublicRun(live.get(run.id) ?? run)), total: page.total };
    },

    async getRun(id: string): Promise<Run> {
      await writes;
      const live = runQueue.list(new Set([id]))[0];
      if (live) return toPublicRun(live);
      const persisted = data.batches.flatMap((batch) => batch.runs).find((run) => run.id === id);
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

    async createBatch(input: unknown): Promise<Batch> {
      const body = parseCreateBatch(input);
      const operation = writes.then(async () => {
        const selected = selectCases(data, body);
        const group = body.groupId === undefined ? undefined : findGroup(data, body.groupId);
        runQueue.reserve(selected.length);
        const id = randomUUID();
        const createdAt = new Date().toISOString();
        const runs: LiveRun[] = selected.map((sourceCase) => {
          const definition = validatedDefinition(sourceCase.definition, registry);
          return {
            id: randomUUID(),
            batchId: id,
            caseId: sourceCase.id,
            status: 'queued',
            createdAt,
            startedAt: null,
            finishedAt: null,
            revision: 0,
            tree: createRunTree(definition),
            artifacts: [],
            definition,
            ...(body.blackboard ? { blackboard: clone(body.blackboard) } : {}),
          };
        });
        const batch: StoredBatch = {
          id,
          createdAt,
          name: body.name ?? group?.name ?? (selected.length === 1 ? selected[0]!.name : `${selected.length} 个 Case`),
          description: body.description ?? '',
          trigger: body.trigger,
          selection: group ? { kind: 'group', groupId: group.id, groupName: group.name } : { kind: 'cases' },
          runs: runs.map(toPublicRun),
        };
        const before = clone(data);
        try {
          data.batches.push(batch);
          await writeSnapshot();
          for (const run of runs) runQueue.enqueue(run);
          for (const run of runs) log.info('created run', run.id, 'case', run.caseId, 'batch', id);
          return publicBatch(batch);
        } catch (error) {
          data.cases = before.cases;
          data.groups = before.groups;
          data.batches = before.batches;
          throw error;
        }
      });
      writes = operation.then(
        () => undefined,
        () => undefined,
      );
      return operation;
    },

    async importBatch(input: unknown): Promise<Batch> {
      const body = parseImportBatch(input);
      const operation = writes.then(async () => {
        const batchId = body.runs[0]!.batchId;
        if (data.batches.some((batch) => batch.id === batchId)) {
          throw new HttpError('conflict', `batch ${batchId} already exists`);
        }
        for (const run of body.runs) {
          if (data.batches.some((batch) => batch.runs.some((item) => item.id === run.id))) {
            throw new HttpError('conflict', `run ${run.id} already exists`);
          }
        }
        const written: string[] = [];
        const before = clone(data);
        try {
          for (const run of body.runs) {
            const files = body.files.filter((file) => file.runId === run.id);
            if (files.length === 0) continue;
            if (workspaceRoot === undefined) throw new Error('workspaceRoot is required');
            const root = join(workspaceRoot, run.id);
            if (existsSync(root)) throw new HttpError('conflict', `run ${run.id} artifact root already exists`);
            await mkdir(root, { recursive: true });
            written.push(root);
            await writeImportedRunFiles(root, run, files);
          }
          const batch: StoredBatch = {
            id: batchId,
            createdAt: earliest(body.runs.map((run) => run.createdAt)),
            name: body.name,
            description: body.description,
            trigger: body.trigger,
            selection: body.selection,
            runs: body.runs.map((run) => clone(run)),
          };
          data.batches.push(batch);
          await writeSnapshot();
          const stored = body.runs.map((run) => clone(run));
          for (const run of stored) log.info('imported run', run.id, 'batch', run.batchId);
          return publicBatch(batch);
        } catch (error) {
          data.cases = before.cases;
          data.groups = before.groups;
          data.batches = before.batches;
          await Promise.all(written.map((root) => rm(root, { recursive: true, force: true })));
          throw error;
        }
      });
      writes = operation.then(
        () => undefined,
        () => undefined,
      );
      return operation;
    },

    async cancelBatch(id: string, onCanceled: (run: Run) => void): Promise<Batch> {
      const batch = await this.getBatch(id);
      for (const run of batch.runs) {
        if (!LIVE_STATUSES.has(run.status)) continue;
        try {
          const canceled = await this.cancelRun(run.id);
          onCanceled(canceled);
        } catch (error) {
          if (!(error instanceof HttpError && error.code === 'conflict')) throw error;
        }
      }
      return this.getBatch(id);
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
      const persisted = data.batches.flatMap((batch) => batch.runs).find((run) => run.id === id);
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
          replaceRun(run);
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
    const data = {
      cases: parsed.cases.map(parseStoredCase),
      groups: parsed.groups,
      batches: parsed.batches,
    };
    const batchIds = new Set<string>();
    const runIds = new Set<string>();
    for (const batch of data.batches) {
      if (batchIds.has(batch.id)) throw new HttpError('invalid', 'duplicate batch id');
      batchIds.add(batch.id);
      for (const run of batch.runs) {
        if (run.batchId !== batch.id) throw new HttpError('invalid', 'run batchId does not match its batch');
        if (runIds.has(run.id)) throw new HttpError('invalid', 'duplicate run id');
        runIds.add(run.id);
      }
    }
    if (new Set(data.groups.map((group) => group.id)).size !== data.groups.length) {
      throw new HttpError('invalid', 'duplicate group id');
    }
    for (const group of data.groups) {
      assertGroupReferences(data, group.caseIds);
      assertUniqueGroupName(data, group.name, group.id);
    }
    return data;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { cases: [], groups: [], batches: [] };
    throw error;
  }
}

function parseStoredCase(value: unknown): TestCase {
  return httpCaseSchema.parse(value);
}

function parseImportBatch(input: unknown) {
  const parsed = httpBatchImportSchema.safeParse(input);
  if (!parsed.success) {
    throw new HttpError('invalid', parsed.error.issues[0]?.message ?? 'invalid request');
  }
  return parsed.data;
}

async function writeImportedRunFiles(
  root: string,
  run: Run,
  files: { artifactId: string; path: string; contentBase64: string }[],
): Promise<void> {
  const items: { id: string; name: string; mediaType: string; path: string }[] = [];
  for (const file of files) {
    const artifact = run.artifacts.find((item) => item.id === file.artifactId);
    if (!artifact) throw new HttpError('invalid', `artifact ${file.artifactId} is not on run ${run.id}`);
    const path = safeArtifactPath(file.path);
    const absolute = join(root, path);
    const escaped = relative(root, absolute).split(sep).join('/');
    if (escaped === '..' || escaped.startsWith('../') || escaped.startsWith('/')) {
      throw new HttpError('invalid', `artifact path escapes the resource root: ${file.path}`);
    }
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, decodeBase64(file.contentBase64));
    items.push({ id: artifact.id, name: artifact.name, mediaType: artifact.mediaType, path });
  }
  await writeFile(join(root, '.tp-artifacts.json'), `${JSON.stringify({ items })}\n`);
}

function safeArtifactPath(path: string): string {
  try {
    return resolveRunArtifactPath(path);
  } catch (error) {
    throw new HttpError('invalid', error instanceof Error ? error.message : 'artifact path is invalid');
  }
}

function decodeBase64(value: string): Buffer {
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new HttpError('invalid', 'artifact content is not base64');
  }
  return Buffer.from(value, 'base64');
}

function parseCreateBatch(input: unknown) {
  const parsed = httpBatchCreateSchema.safeParse(input);
  if (!parsed.success) {
    throw new HttpError('invalid', parsed.error.issues[0]?.message ?? 'invalid request');
  }
  return parsed.data;
}

function selectCases(data: PlatformData, body: { caseIds?: string[]; groupId?: string }): TestCase[] {
  if (body.caseIds !== undefined) return body.caseIds.map((id) => findCase(data, id));
  const group = findGroup(data, body.groupId!);
  if (group.caseIds.length === 0) throw new HttpError('invalid', `group ${group.name} has no cases`);
  return group.caseIds.map((id) => findCase(data, id)).sort((a, b) => a.name.localeCompare(b.name));
}

function findBatch(data: PlatformData, id: string): StoredBatch {
  const batch = data.batches.find((item) => item.id === id);
  if (!batch) throw new HttpError('not_found', `batch ${id} not found`);
  return batch;
}

function earliest(times: string[]): string {
  return times.reduce((first, value) => (Date.parse(value) < Date.parse(first) ? value : first));
}

function summarizeBatch(batch: StoredBatch, runs: Run[]): Batch {
  const { runs: _storedRuns, ...record } = batch;
  const counts: Batch['counts'] = { queued: 0, running: 0, canceling: 0, passed: 0, failed: 0, canceled: 0 };
  for (const run of runs) counts[run.status] += 1;
  const finished = counts.queued + counts.running + counts.canceling === 0;
  const status = finished
    ? counts.failed > 0
      ? 'failed'
      : counts.canceled > 0
        ? 'canceled'
        : 'passed'
    : counts.queued === runs.length
      ? 'queued'
      : 'running';
  const starts = runs.flatMap((run) => (run.startedAt === null ? [] : [run.startedAt]));
  return {
    ...clone(record),
    status,
    counts,
    runs,
    startedAt: starts.length === 0 ? null : earliest(starts),
    finishedAt: finished
      ? runs
          .map((run) => run.finishedAt!)
          .reduce((last, value) => (Date.parse(value) > Date.parse(last) ? value : last))
      : null,
  };
}

function findGroup(data: PlatformData, id: string): TestGroup {
  const group = data.groups.find((item) => item.id === id);
  if (!group) throw new HttpError('not_found', `group ${id} not found`);
  return group;
}

function assertGroupReferences(data: PlatformData, ids: readonly string[]): void {
  for (const id of ids) findCase(data, id);
}

function assertUniqueGroupName(data: PlatformData, name: string, exceptId?: string): void {
  if (data.groups.some((group) => group.name === name && group.id !== exceptId)) {
    throw new HttpError('conflict', `group name ${name} already exists`);
  }
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
  const { definition: _definition, blackboard: _blackboard, ...rest } = run as LiveRun;
  return httpRunSchema.parse(clone(rest));
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function parseCaseWrite(input: unknown) {
  const parsed = httpCaseWriteSchema.safeParse(input);
  if (!parsed.success) throw new HttpError('invalid', parsed.error.issues.map((issue) => issue.message).join('; '));
  return parsed.data;
}
