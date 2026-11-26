import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createRunTree, findRunNode, httpRunSchema, paginate, type Run, type RunNode } from '@tp/contract';

import { createAdapterRegistry } from '../src/adapter-registry.ts';
import { HttpError } from '../src/http-error.ts';
import { createPlatform } from '../src/platform.ts';
import { createRunQueue } from '../src/run-queue.ts';
import { manifest as testManifest } from './fixtures/test-adapter.ts';
import { caseDef } from './case-def.ts';

function platformWithTestAdapter(
  file: string,
  extras: { runQueue?: ReturnType<typeof createRunQueue>; workspaceRoot?: string } = {},
) {
  const registry = createAdapterRegistry();
  registry.register(testManifest);
  return createPlatform(file, { ...extras, registry });
}

function passDefinition() {
  return caseDef({ type: 'Action', capability: 'test.pass', adapter: 'test', actor: 'robot', ports: {} });
}

function isHttpError(code: HttpError['code']) {
  return (error: unknown) => {
    assert.ok(error instanceof HttpError);
    assert.equal(error.code, code);
    return true;
  };
}

function assertPublicRun(run: Run) {
  assert.deepEqual(httpRunSchema.parse(run), run);
}

function walkStatuses(node: RunNode): string[] {
  const statuses = [node.status];
  if ('children' in node) {
    for (const child of node.children) statuses.push(...walkStatuses(child));
  } else if (node.type === 'IfThenElse' || node.type === 'WhileDoElse') {
    statuses.push(...walkStatuses(node.if), ...walkStatuses(node.then));
    if (node.else) statuses.push(...walkStatuses(node.else));
  } else if ('child' in node) {
    statuses.push(...walkStatuses(node.child));
  }
  return statuses;
}

test('duplicate case names conflict; putting the same name on self is allowed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tp-'));
  try {
    const platform = await platformWithTestAdapter(join(dir, 'db.json'));
    const first = await platform.createCase({
      name: 'alpha',
      description: 'alpha',

      definition: passDefinition(),
    });
    await platform.createCase({ name: 'beta', description: 'beta', definition: passDefinition() });

    await assert.rejects(
      () => platform.createCase({ name: 'alpha', description: 'alpha', definition: passDefinition() }),
      isHttpError('conflict'),
    );
    await assert.rejects(
      () =>
        platform.updateCase(first.id, {
          name: 'beta',
          description: 'beta',

          definition: passDefinition(),
        }),
      isHttpError('conflict'),
    );

    const kept = await platform.updateCase(first.id, {
      name: 'alpha',
      description: 'alpha',

      definition: passDefinition(),
    });
    assert.equal(kept.name, 'alpha');
    assert.equal(kept.description, 'alpha');
    await assert.rejects(
      () => platform.createCase({ name: 'gamma', group: 'test', definition: passDefinition() }),
      isHttpError('invalid'),
    );
    assert.equal('createCaseIfAbsent' in platform, false);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test('live queued, running, and canceling runs lock case updates and deletes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tp-'));
  try {
    const queue = createRunQueue();
    const platform = await platformWithTestAdapter(join(dir, 'db.json'), { runQueue: queue });
    const created = await platform.createCase({
      name: 'locked',
      description: 'locked',

      definition: passDefinition(),
    });
    const [run] = (await platform.createBatch({ trigger: { kind: 'web' }, caseIds: [created.id] })).runs;

    assert.equal(platform.hasLiveRuns(created.id), true);
    await assert.rejects(
      () =>
        platform.updateCase(created.id, {
          name: 'locked',
          description: 'locked',

          definition: passDefinition(),
        }),
      isHttpError('conflict'),
    );
    await assert.rejects(() => platform.deleteCase(created.id), isHttpError('conflict'));

    queue.claimNext();
    await assert.rejects(() => platform.deleteCase(created.id), isHttpError('conflict'));

    const canceling = await platform.cancelRun(run.id);
    assert.equal(canceling.status, 'canceling');
    assert.equal(platform.hasLiveRuns(created.id), true);
    await assert.rejects(() => platform.deleteCase(created.id), isHttpError('conflict'));
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test('createBatch keeps blackboard on the live run and off the response', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tp-'));
  try {
    const queue = createRunQueue();
    const platform = await platformWithTestAdapter(join(dir, 'db.json'), { runQueue: queue });
    const created = await platform.createCase({
      name: 'seeded',
      description: 'seeded',

      definition: passDefinition(),
    });
    const [run] = (
      await platform.createBatch({
        trigger: { kind: 'web' },
        caseIds: [created.id],
        blackboard: { 'browser.origin': 'http://127.0.0.1:28188' },
      })
    ).runs;
    assert.equal(Object.hasOwn(run, 'blackboard'), false);
    assert.deepEqual(queue.get(run.id).blackboard, { 'browser.origin': 'http://127.0.0.1:28188' });
    await assert.rejects(
      () =>
        platform.createBatch({
          trigger: { kind: 'web' },
          caseIds: [created.id],
          blackboard: { bad: Number.POSITIVE_INFINITY },
        }),
      isHttpError('invalid'),
    );
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test('finishRun requires a finished status and a started run', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tp-'));
  try {
    const queue = createRunQueue();
    const platform = await platformWithTestAdapter(join(dir, 'db.json'), { runQueue: queue });
    const created = await platform.createCase({
      name: 'finish',
      description: 'finish',

      definition: passDefinition(),
    });
    const [run] = (await platform.createBatch({ trigger: { kind: 'web' }, caseIds: [created.id] })).runs;
    await assert.rejects(() => platform.finishRun(run.id, {}), /invalid run status/);
    await assert.rejects(() => platform.finishRun(run.id, { status: 'passed' }), /has not started/);
    queue.claimNext();
    await assert.rejects(
      () => platform.finishRun(run.id, { status: 'failed' }),
      /failed run has no failed leaf attempt/,
    );
    await assert.rejects(
      () => platform.finishRun(run.id, { status: 'failed', error: '  ' }),
      /failed run has no failed leaf attempt/,
    );
    await platform.finishRun(run.id, { status: 'passed' });
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test('finished runs do not lock deleteCase and remain readable by getRun', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tp-'));
  try {
    const queue = createRunQueue();
    const platform = await platformWithTestAdapter(join(dir, 'db.json'), { runQueue: queue });
    const created = await platform.createCase({
      name: 'delete me',
      description: 'delete me',

      definition: passDefinition(),
    });
    const [run] = (await platform.createBatch({ trigger: { kind: 'web' }, caseIds: [created.id] })).runs;
    queue.claimNext();
    await platform.finishRun(run.id, { status: 'failed', error: 'boom' });

    assert.equal(platform.hasLiveRuns(created.id), false);
    await platform.deleteCase(created.id);
    assert.deepEqual(await platform.listCases(), []);

    const persisted = await platform.getRun(run.id);
    assert.equal(persisted.caseId, created.id);
    assert.equal(persisted.status, 'failed');
    assert.equal(persisted.error, 'boom');
    assertPublicRun(persisted);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test('createBatch allows parallel live runs and rejects a missing case', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tp-'));
  try {
    const platform = await platformWithTestAdapter(join(dir, 'db.json'));
    const created = await platform.createCase({
      name: 'parallel',
      description: 'parallel',

      definition: passDefinition(),
    });

    const [first] = (await platform.createBatch({ trigger: { kind: 'web' }, caseIds: [created.id] })).runs;
    const [second] = (await platform.createBatch({ trigger: { kind: 'web' }, caseIds: [created.id] })).runs;
    assert.equal(first.status, 'queued');
    assert.equal(second.status, 'queued');
    assert.notEqual(first.id, second.id);
    assertPublicRun(first);
    assertPublicRun(second);

    await assert.rejects(
      () => platform.createBatch({ trigger: { kind: 'web' }, caseIds: ['missing'] }),
      isHttpError('not_found'),
    );
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test('Run and Batch pages keep totals, newest batches and live status before pagination', async (context) => {
  const dir = await mkdtemp(join(tmpdir(), 'tp-pages-'));
  try {
    const queue = createRunQueue();
    const platform = await platformWithTestAdapter(join(dir, 'db.json'), { runQueue: queue });
    const firstCase = await platform.createCase({ name: 'first', description: 'first', definition: passDefinition() });
    const secondCase = await platform.createCase({
      name: 'second',
      description: 'second',
      definition: passDefinition(),
    });
    const oldest = await platform.createBatch({ trigger: { kind: 'web' }, caseIds: [firstCase.id] });
    const middle = await platform.createBatch({ trigger: { kind: 'web' }, caseIds: [firstCase.id, secondCase.id] });
    const newest = await platform.createBatch({ trigger: { kind: 'web' }, caseIds: [secondCase.id] });
    queue.claimNext();
    await platform.finishRun(oldest.runs[0]!.id, { status: 'passed' });
    queue.claimNext();
    const serialization = context.mock.method(JSON, 'stringify');
    const batchPage = await platform.listBatches({ limit: 1, offset: 1 });
    const serializedIds = () =>
      serialization.mock.calls.filter((call) => call.arguments[0]?.tree).map((call) => call.arguments[0].id);
    assert.ok(serializedIds().every((id) => middle.runs.some((run) => run.id === id)));
    assert.equal(batchPage.total, 3);
    assert.deepEqual(
      batchPage.items.map((batch) => batch.id),
      [middle.id],
    );
    assert.deepEqual(
      batchPage.items[0]!.runs.map((run) => run.status),
      ['running', 'queued'],
    );
    batchPage.items[0]!.runs[0]!.tree.main = 'changed';
    serialization.mock.resetCalls();
    assert.equal((await platform.getBatch(middle.id)).runs[0]!.tree.main, 'Main');
    assert.ok(serializedIds().every((id) => middle.runs.some((run) => run.id === id)));
    serialization.mock.resetCalls();
    const page = await platform.listRuns({ status: ['queued'], limit: 1, offset: 1 });
    assert.ok(serializedIds().every((id) => id === middle.runs[1]!.id));
    assert.equal(page.total, 2);
    assert.deepEqual(
      page.items.map((run) => run.id),
      [middle.runs[1]!.id],
    );
    const first = await platform.listRuns({ limit: 2, offset: 0 });
    assert.equal(first.total, 4);
    assert.deepEqual(
      first.items.map((run) => run.id),
      [newest.runs[0]!.id, middle.runs[0]!.id],
    );
    assert.deepEqual(await platform.listBatches({ limit: 2, offset: 3 }), { items: [], total: 3 });
    assert.deepEqual(await platform.listRuns({ limit: 2, offset: 4 }), { items: [], total: 4 });
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test('getRun only copies its target for live and finished reads, and isolates returned snapshots', async (context) => {
  const dir = await mkdtemp(join(tmpdir(), 'tp-get-run-'));
  try {
    const queue = createRunQueue();
    const platform = await platformWithTestAdapter(join(dir, 'db.json'), { runQueue: queue });
    const item = await platform.createCase({ name: 'target', description: 'target', definition: passDefinition() });
    const runs = [];
    for (let index = 0; index < 3; index++) {
      runs.push((await platform.createBatch({ caseIds: [item.id], trigger: { kind: 'web' } })).runs[0]!);
    }
    const serialization = context.mock.method(JSON, 'stringify');
    const serializedIds = () =>
      serialization.mock.calls.filter((call) => call.arguments[0]?.tree).map((call) => call.arguments[0].id);
    const snapshot = await platform.getRun(runs[0]!.id);
    assert.ok(serializedIds().every((id) => id === runs[0]!.id));
    assert.equal(snapshot.status, 'queued');
    assertPublicRun(snapshot);
    snapshot.tree.main = 'changed';
    assert.equal((await platform.getRun(snapshot.id)).tree.main, 'Main');
    queue.claimNext();
    await platform.finishRun(snapshot.id, { status: 'passed' });
    serialization.mock.resetCalls();
    const finished = await platform.getRun(snapshot.id);
    assert.equal(finished.status, 'passed');
    assert.ok(serializedIds().every((id) => id === snapshot.id));
    finished.tree.main = 'changed';
    assert.equal((await platform.getRun(snapshot.id)).tree.main, 'Main');
    serialization.mock.resetCalls();
    await assert.rejects(() => platform.getRun('missing'), isHttpError('not_found'));
    assert.deepEqual(serializedIds(), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('listRuns merges live and finished runs, filters by status', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tp-'));
  try {
    const queue = createRunQueue();
    const platform = await platformWithTestAdapter(join(dir, 'db.json'), { runQueue: queue });
    const created = await platform.createCase({
      name: 'listed',
      description: 'listed',

      definition: passDefinition(),
    });
    const [live] = (await platform.createBatch({ trigger: { kind: 'web' }, caseIds: [created.id] })).runs;
    const [finishing] = (await platform.createBatch({ trigger: { kind: 'web' }, caseIds: [created.id] })).runs;
    queue.claimNext();
    queue.claimNext();
    await platform.finishRun(finishing.id, { status: 'passed' });

    const queuedOnly = (await platform.listRuns({ status: ['queued'] })).items;
    assert.deepEqual(
      queuedOnly.map((run) => run.id),
      [],
    );
    assert.ok(queuedOnly.every((run) => run.status === 'queued'));

    const liveOnly = (await platform.listRuns({ status: ['running', 'canceling', 'queued'] })).items;
    assert.deepEqual(
      liveOnly.map((run) => run.id),
      [live.id],
    );
    assertPublicRun(liveOnly[0]!);

    const finishedOnly = (await platform.listRuns({ status: ['passed', 'failed', 'canceled'] })).items;
    assert.deepEqual(
      finishedOnly.map((run) => run.id),
      [finishing.id],
    );
    assertPublicRun(finishedOnly[0]!);

    const all = (await platform.listRuns()).items;
    assert.deepEqual(
      all.map((run) => run.id),
      [finishing.id, live.id],
    );
    const page = paginate(all, { limit: 1, offset: 1 });
    assert.equal(page.total, 2);
    assert.deepEqual(
      page.items.map((run) => run.id),
      [live.id],
    );

    const terminal = await platform.getRun(finishing.id);
    assert.equal(terminal.status, 'passed');
    assertPublicRun(terminal);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test('createBatch copies the case definition into the memory queue only', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tp-'));
  try {
    const queue = createRunQueue();
    const platform = await platformWithTestAdapter(join(dir, 'db.json'), { runQueue: queue });
    const original = {
      type: 'Sequence',
      children: [{ type: 'Action', capability: 'test.pass', adapter: 'test', actor: 'robot', ports: {} }],
    };
    const updated = {
      type: 'Sequence',
      children: [{ type: 'Action', capability: 'test.pass', adapter: 'test', actor: 'robot', ports: {} }],
    };
    const created = await platform.createCase({
      name: 'smoke',
      description: 'smoke',

      definition: caseDef(original),
    });
    const [run] = (await platform.createBatch({ trigger: { kind: 'web' }, caseIds: [created.id] })).runs;
    await platform.cancelRun(run.id);
    const next = await platform.updateCase(created.id, {
      name: 'edited',
      description: 'edited',

      definition: caseDef(updated),
    });
    const [live] = (await platform.createBatch({ trigger: { kind: 'web' }, caseIds: [next.id] })).runs;

    assert.equal(run.status, 'queued');
    assertPublicRun(run);
    assert.deepEqual(queue.get(live.id).definition, caseDef(updated));
    assert.equal('definition' in (await platform.getRun(live.id)), false);
    assert.deepEqual(
      (await platform.listRuns({ status: ['passed', 'failed', 'canceled'] })).items[0]?.status,
      'canceled',
    );
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test('a run initial snapshot is persisted at admission and replaced after execution finishes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tp-'));
  try {
    const queue = createRunQueue();
    const platform = await platformWithTestAdapter(join(dir, 'db.json'), { runQueue: queue });
    const created = await platform.createCase({
      name: 'smoke',
      description: 'smoke',

      definition: passDefinition(),
    });
    const [run] = (await platform.createBatch({ trigger: { kind: 'web' }, caseIds: [created.id] })).runs;
    const admitted = JSON.parse(await readFile(join(dir, 'db.json'), 'utf8'));
    assert.equal('runs' in admitted, false);
    assert.deepEqual(admitted.batches[0].runs, [run]);
    assert.equal('definition' in admitted.batches[0].runs[0], false);
    assert.equal('blackboard' in admitted.batches[0].runs[0], false);
    queue.claimNext();

    const record = await platform.finishRun(run.id, { status: 'passed' });

    assert.equal(record.status, 'passed');
    assertPublicRun(record);
    assert.ok(record.finishedAt);
    assert.deepEqual((await platform.listRuns({ status: ['queued', 'running', 'canceling'] })).items, []);
    assert.equal((await platform.listRuns({ status: ['passed'] })).items.length, 1);

    const reloaded = await createPlatform(join(dir, 'db.json'));
    assert.equal((await reloaded.getRun(run.id)).status, 'passed');
    assertPublicRun(await reloaded.getRun(run.id));
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test('cancelRun persists queued runs, marks running runs canceling, and conflicts on terminal', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tp-'));
  try {
    const queue = createRunQueue();
    const platform = await platformWithTestAdapter(join(dir, 'db.json'), { runQueue: queue });
    const created = await platform.createCase({
      name: 'cancel',
      description: 'cancel',

      definition: passDefinition(),
    });
    const [running] = (await platform.createBatch({ trigger: { kind: 'web' }, caseIds: [created.id] })).runs;
    const [queued] = (await platform.createBatch({ trigger: { kind: 'web' }, caseIds: [created.id] })).runs;
    queue.claimNext();

    const canceled = await platform.cancelRun(queued.id);
    assert.equal(canceled.status, 'canceled');
    assert.ok(canceled.finishedAt);
    assert.equal('error' in canceled, false);
    assert.ok(walkStatuses(canceled.tree.trees.Main!).every((status) => status === 'skipped'));
    assertPublicRun(canceled);
    assert.equal((await platform.getRun(queued.id)).status, 'canceled');

    const canceling = await platform.cancelRun(running.id);
    assert.equal(canceling.status, 'canceling');
    assert.equal(canceling.finishedAt, null);
    assertPublicRun(canceling);
    assert.equal((await platform.cancelRun(running.id)).status, 'canceling');
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test('cancelRun on a finished run conflicts and a missing run is not_found', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tp-'));
  try {
    const queue = createRunQueue();
    const platform = await platformWithTestAdapter(join(dir, 'db.json'), { runQueue: queue });
    const created = await platform.createCase({
      name: 'done',
      description: 'done',

      definition: passDefinition(),
    });
    const [run] = (await platform.createBatch({ trigger: { kind: 'web' }, caseIds: [created.id] })).runs;
    queue.claimNext();
    await platform.finishRun(run.id, { status: 'passed' });

    await assert.rejects(() => platform.cancelRun(run.id), isHttpError('conflict'));
    await assert.rejects(() => platform.cancelRun('missing'), isHttpError('not_found'));
    await assert.rejects(() => platform.getRun('missing'), isHttpError('not_found'));
    await assert.rejects(() => platform.deleteCase('missing'), isHttpError('not_found'));
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test('case definitions are validated against registered capabilities', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tp-'));
  try {
    const platform = await createPlatform(join(dir, 'db.json'));

    await assert.rejects(
      () =>
        platform.createCase({
          name: 'bad',
          description: 'bad',

          definition: caseDef({ type: 'Action', capability: 'missing.action', adapter: 'test', actor: 'robot' }),
        }),
      /capability test\/missing.action is not registered/,
    );
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test('a rejected case update does not partially mutate the stored case', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tp-'));
  try {
    const platform = await platformWithTestAdapter(join(dir, 'db.json'));
    const created = await platform.createCase({
      name: 'original',
      description: 'original',

      definition: passDefinition(),
    });

    await assert.rejects(
      () =>
        platform.updateCase(created.id, {
          name: 'mutated',
          description: 'mutated',

          definition: caseDef({ type: 'Action', capability: 'missing.action', adapter: 'test', actor: 'robot' }),
        }),
      /capability test\/missing.action is not registered/,
    );

    assert.equal((await platform.listCases())[0].name, 'original');
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test('a case cannot run when its adapter is no longer registered', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tp-'));
  try {
    const file = join(dir, 'db.json');
    const registry = createAdapterRegistry();
    registry.register({
      id: 'temporary',
      moduleEntry: 'file:///tmp/temporary.ts',
      capabilities: [{ key: 'temporary.action', kind: 'Action', label: 'Temporary', ports: [] }],
    });
    const configured = await createPlatform(file, { registry });
    const created = await configured.createCase({
      name: 'temporary',
      description: 'temporary',

      definition: caseDef({ type: 'Action', capability: 'temporary.action', adapter: 'temporary', actor: 'robot' }),
    });
    const restarted = await createPlatform(file);

    await assert.rejects(
      () => restarted.createBatch({ trigger: { kind: 'web' }, caseIds: [created.id] }),
      /capability temporary\/temporary.action is not registered/,
    );
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test('loading persisted cases rejects a definition that is not a tree document', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tp-'));
  try {
    const file = join(dir, 'db.json');
    await writeFile(
      file,
      `${JSON.stringify(
        {
          cases: [
            {
              id: 'invalid-1',
              name: 'Visual editor smoke',
              description: 'Visual editor smoke',

              definition: { extra: true },
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z',
            },
          ],
          groups: [],
          batches: [],
        },
        null,
        2,
      )}\n`,
    );

    await assert.rejects(() => createPlatform(file));
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test('loading persisted cases rejects a structurally illegal tree document', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tp-'));
  try {
    const file = join(dir, 'db.json');
    await writeFile(
      file,
      `${JSON.stringify(
        {
          cases: [
            {
              id: 'empty-seq',
              name: 'empty sequence',
              description: 'empty sequence',

              definition: {
                main: 'Main',
                trees: { Main: { type: 'Sequence', children: [] } },
              },
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z',
            },
          ],
          groups: [],
          batches: [],
        },
        null,
        2,
      )}\n`,
    );

    await assert.rejects(() => createPlatform(file), /too_small|children|invalid/i);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test('createBatch initializes a pending tree and finishRun persists only trusted finalized progress', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tp-'));
  try {
    const queue = createRunQueue();
    const platform = await platformWithTestAdapter(join(dir, 'db.json'), { runQueue: queue });
    const created = await platform.createCase({
      name: 'trusted progress',
      description: 'trusted progress',

      definition: caseDef({
        type: 'Sequence',
        children: [
          { type: 'Action', capability: 'test.pass', adapter: 'test', actor: 'robot', ports: {} },
          { type: 'Action', capability: 'test.pass', adapter: 'test', actor: 'robot', ports: {} },
        ],
      }),
    });
    const [run] = (await platform.createBatch({ trigger: { kind: 'web' }, caseIds: [created.id] })).runs;
    assert.equal(run.revision, 0);
    assert.ok(walkStatuses(run.tree.trees.Main!).every((status) => status === 'pending'));
    queue.claimNext();
    queue.applyProgress(run.id, {
      revision: 1,
      kind: 'started',
      path: '',
      nodeType: 'Sequence',
      attempt: 1,
      timestamp: '2026-09-10T00:00:00.000Z',
    });
    queue.applyProgress(run.id, {
      revision: 2,
      kind: 'finished',
      path: '',
      nodeType: 'Sequence',
      attempt: 1,
      timestamp: '2026-09-10T00:00:01.000Z',
      status: 'failed',
      error: 'trusted event',
    });

    const record = await platform.finishRun(run.id, {
      status: 'failed',
      error: 'trusted event',
      tree: { revision: 999, trees: {} },
    });

    assert.equal(record.status, 'failed');
    assert.equal(record.error, 'trusted event');
    assert.ok(record.error.trim().length > 0);
    assert.equal(record.revision, 3);
    assert.deepEqual(
      [
        findRunNode(record.tree, '').status,
        findRunNode(record.tree, 'children.0').status,
        findRunNode(record.tree, 'children.1').status,
      ],
      ['failed', 'skipped', 'skipped'],
    );
    assertPublicRun(record);
    assert.deepEqual((await platform.getRun(run.id)).tree, record.tree);
    assert.equal((await platform.getRun(run.id)).revision, record.revision);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test('cancelRun leaves the queued run gettable when persistence fails', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tp-'));
  try {
    const file = join(dir, 'db.json');
    const queue = createRunQueue();
    const platform = await platformWithTestAdapter(file, { runQueue: queue });
    const created = await platform.createCase({
      name: 'queued cancel persist failure',
      description: 'queued cancel persist failure',

      definition: passDefinition(),
    });
    const [run] = (await platform.createBatch({ trigger: { kind: 'web' }, caseIds: [created.id] })).runs;
    await rm(file);
    await mkdir(file);

    await assert.rejects(() => platform.cancelRun(run.id));
    assert.equal((await platform.getRun(run.id)).status, 'queued');
    assert.equal(queue.get(run.id).status, 'queued');
    assert.deepEqual((await platform.listRuns({ status: ['canceled'] })).items, []);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test('finishRun leaves the live trusted snapshot in place when persistence fails', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tp-'));
  try {
    const file = join(dir, 'db.json');
    const queue = createRunQueue();
    const platform = await platformWithTestAdapter(file, { runQueue: queue });
    const created = await platform.createCase({
      name: 'persistence failure',
      description: 'persistence failure',

      definition: passDefinition(),
    });
    const [run] = (await platform.createBatch({ trigger: { kind: 'web' }, caseIds: [created.id] })).runs;
    queue.claimNext();
    queue.applyProgress(run.id, {
      revision: 1,
      kind: 'started',
      path: '',
      nodeType: 'Action',
      capability: 'test.pass',
      actor: 'robot',
      attempt: 1,
      timestamp: '2026-09-10T00:00:00.000Z',
    });
    await rm(file);
    await mkdir(file);

    await assert.rejects(() => platform.finishRun(run.id, { status: 'failed', error: 'worker fatal' }));
    assert.equal(queue.get(run.id).revision, 1);
    assert.equal(findRunNode(queue.get(run.id).tree, '').status, 'running');
    assert.deepEqual((await platform.listRuns({ status: ['passed', 'failed', 'canceled'] })).items, []);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test('loading persisted data rejects unknown fields', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tp-'));
  try {
    const extraRoot = join(dir, 'extra-root.json');
    await writeFile(
      extraRoot,
      JSON.stringify({
        cases: [],
        groups: [],
        batches: [],
        extra: true,
      }),
    );
    await assert.rejects(() => createPlatform(extraRoot));

    const extraRun = join(dir, 'extra-run.json');
    const run = storedRun('run-1', 'batch-1');
    await writeFile(
      extraRun,
      JSON.stringify({
        cases: [],
        groups: [],
        batches: [
          {
            name: 'Stored Batch',
            description: '',
            trigger: { kind: 'web' },
            selection: { kind: 'cases' },
            id: 'batch-1',
            createdAt: run.createdAt,
            runs: [{ ...run, extra: true }],
          },
        ],
      }),
    );
    await assert.rejects(() => createPlatform(extraRun));
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test('overlapping finishRun calls persist one terminal snapshot without removing it early', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tp-'));
  try {
    const queue = createRunQueue();
    const platform = await platformWithTestAdapter(join(dir, 'db.json'), { runQueue: queue });
    const created = await platform.createCase({
      name: 'overlap',
      description: 'overlap',

      definition: passDefinition(),
    });
    const [run] = (await platform.createBatch({ trigger: { kind: 'web' }, caseIds: [created.id] })).runs;
    queue.claimNext();

    const first = platform.finishRun(run.id, { status: 'canceled' });
    await assert.rejects(
      () => platform.finishRun(run.id, { status: 'failed', error: 'duplicate' }),
      /already finishing/,
    );
    const record = await first;

    assert.equal(record.status, 'canceled');
    assert.equal('error' in record, false);
    assert.ok(walkStatuses(record.tree.trees.Main!).every((status) => status === 'skipped'));
    assert.equal((await platform.listRuns({ status: ['canceled'] })).items.length, 1);
    assert.deepEqual((await platform.listRuns({ status: ['queued', 'running', 'canceling'] })).items, []);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test('createBatch returns one batch for a case or a group', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tp-'));
  try {
    const platform = await platformWithTestAdapter(join(dir, 'db.json'));
    const zeta = await platform.createCase({
      name: 'zeta',
      description: 'zeta',

      definition: passDefinition(),
    });
    const alpha = await platform.createCase({
      name: 'alpha',
      description: 'alpha',

      definition: passDefinition(),
    });
    await platform.createCase({
      name: 'other',
      description: 'other',

      definition: passDefinition(),
    });

    const [single] = (await platform.createBatch({ trigger: { kind: 'web' }, caseIds: [zeta.id] })).runs;
    assert.equal(single?.caseId, zeta.id);
    assert.ok(single?.batchId);

    const group = await platform.createGroup({ name: 'pack', caseIds: [zeta.id, alpha.id] });
    const grouped = (await platform.createBatch({ trigger: { kind: 'web' }, groupId: group.id })).runs;
    assert.deepEqual(
      grouped.map((run) => run.caseId),
      [alpha.id, zeta.id],
    );
    assert.equal(grouped[0]?.batchId, grouped[1]?.batchId);
    assert.notEqual(grouped[0]?.batchId, single?.batchId);
    assert.equal(new Set(grouped.map((run) => run.batchId)).size, 1);

    await assert.rejects(
      () => platform.createBatch({ trigger: { kind: 'web' }, groupId: 'missing' }),
      isHttpError('not_found'),
    );
    await assert.rejects(() => platform.createBatch({ trigger: { kind: 'web' } }), isHttpError('invalid'));
    await assert.rejects(
      () => platform.createBatch({ trigger: { kind: 'web' }, caseIds: [zeta.id], groupId: group.id }),
      isHttpError('invalid'),
    );

    const tightQueue = createRunQueue({ capacity: 1 });
    const tight = await platformWithTestAdapter(join(dir, 'tight.json'), { runQueue: tightQueue });
    await tight.createCase({ name: 'alpha', description: 'alpha', definition: passDefinition() });
    await tight.createCase({ name: 'zeta', description: 'zeta', definition: passDefinition() });
    const tightGroup = await tight.createGroup({
      name: 'pack',
      caseIds: (await tight.listCases()).map((item) => item.id),
    });
    await assert.rejects(() => tight.createBatch({ trigger: { kind: 'web' }, groupId: tightGroup.id }), /capacity/);
    assert.deepEqual(tightQueue.list(), []);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

function storedRun(id: string, batchId: string, status: Run['status'] = 'passed'): Run {
  return {
    id,
    batchId,
    caseId: 'not-in-catalog',
    status,
    createdAt: '2026-11-10T00:00:00.000Z',
    startedAt: '2026-11-10T00:00:00.000Z',
    finishedAt: '2026-11-10T00:00:01.000Z',
    revision: 1,
    tree: createRunTree(passDefinition()),
    artifacts: [],
    ...(status === 'failed' ? { error: 'leaf failed' } : {}),
  };
}

test('pruneBatches removes expired terminal batches and files, preserving the cutoff and live batches', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tp-'));
  try {
    const file = join(dir, 'db.json');
    const workspaceRoot = join(dir, 'runs');
    const runQueue = createRunQueue();
    const platform = await platformWithTestAdapter(file, { workspaceRoot, runQueue });
    const item = await platform.createCase({ name: 'kept', description: 'kept', definition: passDefinition() });
    const group = await platform.createGroup({ name: 'kept', caseIds: [item.id] });
    const cutoff = Date.parse('2026-11-11T00:00:00.000Z');
    const expired = ['passed', 'failed', 'canceled'].map((status) => ({
      ...storedRun(`expired-${status}`, 'expired-batch', status as Run['status']),
      finishedAt: new Date(cutoff - 1).toISOString(),
    }));
    const boundary = { ...storedRun('boundary', 'boundary-batch'), finishedAt: new Date(cutoff).toISOString() };
    const recent = { ...storedRun('recent', 'recent-batch'), finishedAt: new Date(cutoff + 1).toISOString() };
    for (const members of [expired, [boundary], [recent]]) {
      const runs = members.map((run) => ({
        ...run,
        artifacts: [{ id: 'log', name: 'steps.log', mediaType: 'text/plain' }],
      }));
      await platform.importBatch({
        name: 'Imported Batch',
        description: '',
        trigger: { kind: 'web' },
        selection: { kind: 'cases' },
        runs,
        files: runs.map((run) => ({
          runId: run.id,
          artifactId: 'log',
          path: 'steps.log',
          contentBase64: Buffer.from(run.id).toString('base64'),
        })),
      });
    }
    const live = [];
    for (let index = 0; index < 3; index++) {
      live.push((await platform.createBatch({ trigger: { kind: 'web' }, caseIds: [item.id] })).runs[0]!);
    }
    runQueue.claimNext();
    runQueue.markCanceling(live[0]!.id);
    runQueue.claimNext();
    const fresh = { ...storedRun('fresh', 'fresh-batch'), finishedAt: new Date(cutoff + 2).toISOString() };
    const [removed] = await Promise.all([
      platform.pruneBatches(cutoff),
      platform.importBatch({
        name: 'Imported Batch',
        description: '',
        trigger: { kind: 'web' },
        selection: { kind: 'cases' },
        runs: [fresh],
        files: [],
      }),
    ]);
    assert.equal(removed, 1, 'retention counts whole batches, including all three terminal members');
    const expected = ['fresh', ...live.map((run) => run.id).reverse(), 'recent', 'boundary'];
    assert.deepEqual(
      (await platform.listRuns()).items.map((run) => run.id),
      expected,
    );
    assert.deepEqual(
      (await platform.listRuns({ status: ['canceling', 'running', 'queued'] })).items.map((run) => run.status),
      ['queued', 'running', 'canceling'],
    );
    for (const run of expired) {
      await assert.rejects(() => platform.getRun(run.id), isHttpError('not_found'));
      await assert.rejects(() => stat(join(workspaceRoot, run.id)), { code: 'ENOENT' });
    }
    assert.equal((await platform.getRunArtifact('boundary', 'log')).bytes.toString(), 'boundary');
    assert.deepEqual(await platform.listCases(), [item]);
    assert.deepEqual(await platform.listGroups(), [group]);
    const restarted = await platformWithTestAdapter(file, { workspaceRoot });
    assert.deepEqual(
      (await restarted.listRuns()).items.map((run) => run.id),
      expected,
    );
    for (const run of live) {
      const recovered = await restarted.getRun(run.id);
      assert.equal(recovered.status, 'failed');
      assert.equal(recovered.error, 'server restarted before run completed');
    }
    assert.equal(await platform.pruneBatches(cutoff), 0);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test('importBatch rejects unsafe resource roots before any files or records are written', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tp-'));
  try {
    const file = join(dir, 'db.json');
    const workspaceRoot = join(dir, 'runs');
    const platform = await platformWithTestAdapter(file, { workspaceRoot });
    const run = storedRun('../outside', 'batch');
    await writeFile(join(dir, 'outside'), 'keep');
    await assert.rejects(
      () =>
        platform.importBatch({
          name: 'Imported Batch',
          description: '',
          trigger: { kind: 'web' },
          selection: { kind: 'cases' },
          runs: [run],
          files: [],
        }),
      /invalid run resource root/,
    );
    assert.deepEqual((await platform.listRuns()).items, []);
    assert.equal(await readFile(join(dir, 'outside'), 'utf8'), 'keep');
    const restarted = await platformWithTestAdapter(file);
    assert.deepEqual((await restarted.listRuns()).items, []);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test('pruneBatches reports file cleanup errors and can retry without losing the run record', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tp-'));
  try {
    const workspaceRoot = join(dir, 'blocked');
    await writeFile(workspaceRoot, 'not a directory');
    const platform = await platformWithTestAdapter(join(dir, 'db.json'), { workspaceRoot });
    const run = storedRun('expired', 'batch');
    await platform.importBatch({
      name: 'Imported Batch',
      description: '',
      trigger: { kind: 'web' },
      selection: { kind: 'cases' },
      runs: [run],
      files: [],
    });
    await assert.rejects(() => platform.pruneBatches(Date.now()), { code: 'ENOTDIR' });
    assert.deepEqual((await platform.listRuns()).items, [run]);
    await rm(workspaceRoot);
    assert.equal(await platform.pruneBatches(Date.now()), 1);
    assert.deepEqual((await platform.listRuns()).items, []);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test('importBatch appends terminal runs without a case and keeps their batch', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tp-'));
  try {
    const platform = await platformWithTestAdapter(join(dir, 'db.json'), {
      workspaceRoot: join(dir, 'runs'),
    });
    const alpha = storedRun('run-alpha', 'batch-1');
    const zeta = storedRun('run-zeta', 'batch-1', 'failed');
    const imported = await platform.importBatch({
      name: 'Imported Batch',
      description: '',
      trigger: { kind: 'web' },
      selection: { kind: 'cases' },
      runs: [zeta, alpha],
      files: [],
    });
    assert.deepEqual(
      imported.runs.map((run) => run.id),
      ['run-zeta', 'run-alpha'],
    );
    assert.equal(imported.runs[0]?.batchId, 'batch-1');
    const listed = (await platform.listRuns()).items;
    assert.deepEqual(
      listed.map((run) => run.id),
      ['run-zeta', 'run-alpha'],
    );

    await assert.rejects(
      () =>
        platform.importBatch({
          name: 'Imported Batch',
          description: '',
          trigger: { kind: 'web' },
          selection: { kind: 'cases' },
          runs: [storedRun('run-alpha', 'batch-2')],
          files: [],
        }),
      isHttpError('conflict'),
    );
    assert.equal((await platform.listRuns()).items.length, 2);

    await assert.rejects(
      () =>
        platform.importBatch({
          name: 'Imported Batch',
          description: '',
          trigger: { kind: 'web' },
          selection: { kind: 'cases' },
          runs: [storedRun('run-a', 'batch-a'), storedRun('run-b', 'batch-b')],
          files: [],
        }),
      isHttpError('invalid'),
    );
    await assert.rejects(
      () =>
        platform.importBatch({
          name: 'Imported Batch',
          description: '',
          trigger: { kind: 'web' },
          selection: { kind: 'cases' },
          runs: [{ ...storedRun('run-c', 'batch-c', 'failed'), error: '   ' }],
          files: [],
        }),
      isHttpError('invalid'),
    );
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test('importBatch writes large artifact bytes and rejects invalid files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tp-'));
  try {
    const workspaceRoot = join(dir, 'runs');
    const platform = await platformWithTestAdapter(join(dir, 'db.json'), { workspaceRoot });
    const content = Buffer.alloc(4 * 1024 * 1024, 0xff);
    const run = {
      ...storedRun('run-log', 'batch-log'),
      artifacts: [{ id: 'art-1', name: 'steps.log', mediaType: 'text/plain' }],
    };
    const imported = await platform.importBatch({
      name: 'Imported Batch',
      description: '',
      trigger: { kind: 'web' },
      selection: { kind: 'cases' },
      runs: [run],
      files: [
        {
          runId: run.id,
          artifactId: 'art-1',
          path: 'steps.log',
          contentBase64: content.toString('base64'),
        },
      ],
    });
    assert.equal(imported.runs.length, 1);
    const artifact = await platform.getRunArtifact(run.id, 'art-1');
    assert.deepEqual(artifact.bytes, content);
    assert.equal(artifact.mediaType, 'text/plain');

    for (const contentBase64 of ['AAA', 'A===', 'AA=A', 'AA!A', 'AAAA=']) {
      const invalid = { ...run, id: 'invalid-base64', batchId: 'invalid-base64-batch' };
      await assert.rejects(
        () =>
          platform.importBatch({
            name: 'Imported Batch',
            description: '',
            trigger: { kind: 'web' },
            selection: { kind: 'cases' },
            runs: [invalid],
            files: [{ runId: invalid.id, artifactId: 'art-1', path: 'steps.log', contentBase64 }],
          }),
        isHttpError('invalid'),
      );
    }

    const missing = {
      ...storedRun('run-missing', 'batch-missing'),
      artifacts: [{ id: 'art-2', name: 'steps.log', mediaType: 'text/plain' }],
    };
    await assert.rejects(
      () =>
        platform.importBatch({
          name: 'Imported Batch',
          description: '',
          trigger: { kind: 'web' },
          selection: { kind: 'cases' },
          runs: [missing],
          files: [],
        }),
      isHttpError('invalid'),
    );
    const escape = {
      ...storedRun('run-escape', 'batch-escape'),
      artifacts: [{ id: 'art-x', name: 'secret', mediaType: 'text/plain' }],
    };
    await assert.rejects(
      () =>
        platform.importBatch({
          name: 'Imported Batch',
          description: '',
          trigger: { kind: 'web' },
          selection: { kind: 'cases' },
          runs: [escape],
          files: [{ runId: 'run-escape', artifactId: 'art-x', path: '../secret', contentBase64: '' }],
        }),
      isHttpError('invalid'),
    );
    assert.equal((await platform.listRuns()).items.length, 1);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});
