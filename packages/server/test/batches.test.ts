import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createRunTree, type Run } from '@tp/contract';
import { createAdapterRegistry } from '../src/adapter-registry.ts';
import { createPlatform } from '../src/platform.ts';
import { createRunQueue } from '../src/run-queue.ts';
import { manifest } from './fixtures/test-adapter.ts';
import { caseDef } from './case-def.ts';

const definition = caseDef({ type: 'Action', capability: 'test.pass', adapter: 'test', actor: 'robot', ports: {} });

async function setup(dir: string, capacity = 1000) {
  const registry = createAdapterRegistry();
  registry.register(manifest);
  const queue = createRunQueue({ capacity });
  const platform = await createPlatform(join(dir, 'db.json'), {
    registry,
    runQueue: queue,
    workspaceRoot: join(dir, 'runs'),
  });
  const cases = await Promise.all(
    ['alpha', 'beta', 'gamma'].map((name) => platform.createCase({ name, description: name, definition })),
  );
  return { platform, queue, cases };
}

function importedRun(id: string, batchId: string, finishedAt: string): Run {
  return {
    id,
    batchId,
    caseId: 'absent',
    status: 'passed',
    createdAt: '2026-10-01T00:00:00.000Z',
    startedAt: '2026-10-01T00:00:00.000Z',
    finishedAt,
    revision: 1,
    tree: createRunTree(definition),
    artifacts: [],
  };
}

test('single, multiple and Group selections create fixed native Batch members', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tp-batch-'));
  try {
    const { platform, cases } = await setup(dir);
    const single = await platform.createBatch({ trigger: { kind: 'web' }, caseIds: [cases[0]!.id] });
    assert.equal(single.runs.length, 1);
    assert.equal(single.status, 'queued');
    assert.equal(single.runs[0]!.batchId, single.id);
    const multiple = await platform.createBatch({ trigger: { kind: 'web' }, caseIds: [cases[1]!.id, cases[0]!.id] });
    assert.deepEqual(
      multiple.runs.map((run) => run.caseId),
      [cases[1]!.id, cases[0]!.id],
    );
    const group = await platform.createGroup({ name: 'group', caseIds: [cases[1]!.id, cases[0]!.id] });
    const grouped = await platform.createBatch({ trigger: { kind: 'web' }, groupId: group.id });
    await platform.updateGroup(group.id, { name: 'changed', caseIds: [cases[2]!.id] });
    assert.deepEqual(
      (await platform.getBatch(grouped.id)).runs.map((run) => run.caseId),
      [cases[0]!.id, cases[1]!.id],
    );
    assert.equal((await platform.listBatches()).items.length, 3);
    assert.equal((await platform.listRuns()).items.length, 5);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('invalid selections and exhausted capacity create no partial Batch or queued members', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tp-batch-'));
  try {
    const { platform, queue, cases } = await setup(dir, 1);
    await assert.rejects(
      () => platform.createBatch({ trigger: { kind: 'web' }, caseIds: [cases[0]!.id, 'missing'] }),
      /not found/,
    );
    await assert.rejects(
      () => platform.createBatch({ trigger: { kind: 'web' }, caseIds: [cases[0]!.id, cases[1]!.id] }),
      /capacity/,
    );
    assert.deepEqual(queue.list(), []);
    assert.deepEqual((await platform.listBatches()).items, []);
    const stored = JSON.parse(await readFile(join(dir, 'db.json'), 'utf8'));
    assert.deepEqual(stored.batches, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Batch progress overlays live Runs and stays running until every member finishes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tp-batch-'));
  try {
    const { platform, queue, cases } = await setup(dir);
    const batch = await platform.createBatch({ trigger: { kind: 'web' }, caseIds: cases.map((item) => item.id) });
    const first = queue.claimNext()!;
    await platform.finishRun(first.id, { status: 'failed', error: 'first failed' });
    const second = queue.claimNext()!;
    const ongoing = await platform.getBatch(batch.id);
    assert.equal(ongoing.status, 'running');
    assert.deepEqual(ongoing.counts, { queued: 1, running: 1, canceling: 0, passed: 0, failed: 1, canceled: 0 });
    assert.equal(ongoing.finishedAt, null);
    assert.equal(ongoing.startedAt, first.startedAt);
    await platform.finishRun(second.id, { status: 'passed' });
    const last = queue.claimNext()!;
    await platform.finishRun(last.id, { status: 'canceled' });
    const finished = await platform.getBatch(batch.id);
    assert.equal(finished.status, 'failed');
    assert.equal(finished.counts.passed, 1);
    assert.equal(finished.counts.canceled, 1);
    assert.ok(finished.finishedAt);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('cancelBatch cancels its queued members and requests cancellation of only its running members', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tp-batch-'));
  try {
    const { platform, queue, cases } = await setup(dir);
    const batch = await platform.createBatch({ trigger: { kind: 'web' }, caseIds: [cases[0]!.id, cases[1]!.id] });
    const unrelated = await platform.createBatch({ trigger: { kind: 'web' }, caseIds: [cases[2]!.id] });
    const active = queue.claimNext()!;
    const canceling = await platform.cancelBatch(batch.id, () => {});
    assert.equal(canceling.counts.canceling, 1);
    assert.equal(canceling.counts.canceled, 1);
    assert.equal((await platform.getBatch(unrelated.id)).status, 'queued');
    await platform.finishRun(active.id, { status: 'canceled' });
    assert.equal((await platform.getBatch(batch.id)).status, 'canceled');
    assert.equal((await platform.cancelBatch(batch.id, () => {})).status, 'canceled');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('restart retains fixed Batch members and fails unfinished members without resuming them', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tp-batch-'));
  try {
    const { platform, queue, cases } = await setup(dir);
    const batch = await platform.createBatch({ trigger: { kind: 'web' }, caseIds: [cases[0]!.id, cases[1]!.id] });
    const active = queue.claimNext()!;
    await platform.finishRun(active.id, { status: 'passed' });
    const restarted = await createPlatform(join(dir, 'db.json'));
    const recovered = await restarted.getBatch(batch.id);
    assert.equal(recovered.runs.length, 2);
    assert.equal(recovered.status, 'failed');
    assert.equal(recovered.counts.passed, 1);
    assert.equal(recovered.counts.failed, 1);
    assert.equal(recovered.runs[1]!.error, 'server restarted before run completed');
    assert.equal(recovered.runs[1]!.id, batch.runs[1]!.id);
    assert.equal(restarted.hasLiveRuns(cases[1]!.id), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('retention prunes whole completed Batches after the last member, preserving incomplete batches', async (context) => {
  const dir = await mkdtemp(join(tmpdir(), 'tp-batch-'));
  const now = Date.parse('2026-11-18T00:00:00.000Z');
  const cutoff = now - 7 * 86400000;
  context.mock.timers.enable({ apis: ['Date'], now: now - 10 * 86400000 });
  try {
    const { platform, queue, cases } = await setup(dir);
    const live = await platform.createBatch({ trigger: { kind: 'web' }, caseIds: [cases[0]!.id, cases[1]!.id] });
    const active = queue.claimNext()!;
    await platform.finishRun(active.id, { status: 'passed' });
    context.mock.timers.setTime(now);
    const old = importedRun('old', 'expired', new Date(cutoff - 1).toISOString());
    const early = importedRun('early', 'kept', new Date(cutoff - 86400000).toISOString());
    const last = importedRun('last', 'kept', new Date(cutoff).toISOString());
    await platform.importBatch({
      name: 'Imported Batch',
      description: '',
      trigger: { kind: 'web' },
      selection: { kind: 'cases' },
      runs: [old],
      files: [],
    });
    await platform.importBatch({
      name: 'Imported Batch',
      description: '',
      trigger: { kind: 'web' },
      selection: { kind: 'cases' },
      runs: [early, last],
      files: [],
    });
    for (const run of [old, early, last]) {
      await mkdir(join(dir, 'runs', run.id), { recursive: true });
    }
    assert.equal(await platform.pruneBatches(cutoff), 1);
    assert.equal((await platform.getBatch('kept')).runs.length, 2);
    assert.equal((await platform.getBatch(live.id)).runs.length, 2);
    await assert.rejects(() => platform.getBatch('expired'), /not found/);
    await assert.rejects(() => readFile(join(dir, 'runs', 'old', 'anything')), { code: 'ENOENT' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Batch creation persists before admission and leaves no live members if persistence fails', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tp-batch-'));
  try {
    const { platform, queue, cases } = await setup(dir);
    await rm(join(dir, 'db.json'));
    await mkdir(join(dir, 'db.json'));
    await assert.rejects(() => platform.createBatch({ trigger: { kind: 'web' }, caseIds: [cases[0]!.id] }));
    assert.deepEqual(queue.list(), []);
    assert.deepEqual((await platform.listBatches()).items, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Batch cancellation delivers halt before a later queued-member persistence failure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tp-batch-'));
  try {
    const { platform, queue, cases } = await setup(dir);
    const batch = await platform.createBatch({ trigger: { kind: 'web' }, caseIds: [cases[0]!.id, cases[1]!.id] });
    const active = queue.claimNext()!;
    await rm(join(dir, 'db.json'));
    await mkdir(join(dir, 'db.json'));
    const halted: string[] = [];
    await assert.rejects(() =>
      platform.cancelBatch(batch.id, (run) => {
        if (run.status === 'canceling') halted.push(run.id);
      }),
    );
    assert.deepEqual(halted, [active.id]);
    assert.equal(queue.get(batch.runs[1]!.id).status, 'queued');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
