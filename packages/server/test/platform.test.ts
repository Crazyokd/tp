import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { findRunNode, httpRunSchema, paginate, type Run, type RunNode } from '@tp/contract';

import { createAdapterRegistry } from '../src/adapter-registry.ts';
import { HttpError } from '../src/http-error.ts';
import { createPlatform } from '../src/platform.ts';
import { createRunQueue } from '../src/run-queue.ts';
import { manifest as testManifest } from './fixtures/test-adapter.ts';
import { caseDef } from './case-def.ts';

function platformWithTestAdapter(file: string, extras: { runQueue?: ReturnType<typeof createRunQueue> } = {}) {
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
    const first = await platform.createCase({ name: 'alpha', definition: passDefinition() });
    await platform.createCase({ name: 'beta', definition: passDefinition() });

    await assert.rejects(
      () => platform.createCase({ name: 'alpha', definition: passDefinition() }),
      isHttpError('conflict'),
    );
    await assert.rejects(
      () => platform.updateCase(first.id, { name: 'beta', definition: passDefinition() }),
      isHttpError('conflict'),
    );

    const kept = await platform.updateCase(first.id, { name: 'alpha', definition: passDefinition() });
    assert.equal(kept.name, 'alpha');
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
    const created = await platform.createCase({ name: 'locked', definition: passDefinition() });
    const run = await platform.createRun({ caseId: created.id });

    assert.equal(platform.hasLiveRuns(created.id), true);
    await assert.rejects(
      () => platform.updateCase(created.id, { name: 'locked', definition: passDefinition() }),
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

test('finishRun requires a finished status and a started run', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tp-'));
  try {
    const queue = createRunQueue();
    const platform = await platformWithTestAdapter(join(dir, 'db.json'), { runQueue: queue });
    const created = await platform.createCase({ name: 'finish', definition: passDefinition() });
    const run = await platform.createRun({ caseId: created.id });
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
    const created = await platform.createCase({ name: 'delete me', definition: passDefinition() });
    const run = await platform.createRun({ caseId: created.id });
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

test('createRun allows parallel live runs and rejects a missing case', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tp-'));
  try {
    const platform = await platformWithTestAdapter(join(dir, 'db.json'));
    const created = await platform.createCase({ name: 'parallel', definition: passDefinition() });

    const first = await platform.createRun({ caseId: created.id });
    const second = await platform.createRun({ caseId: created.id });
    assert.equal(first.status, 'queued');
    assert.equal(second.status, 'queued');
    assert.notEqual(first.id, second.id);
    assertPublicRun(first);
    assertPublicRun(second);

    await assert.rejects(() => platform.createRun({ caseId: 'missing' }), isHttpError('not_found'));
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test('listRuns merges live and finished runs, filters by status, then the caller paginates', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tp-'));
  try {
    const queue = createRunQueue();
    const platform = await platformWithTestAdapter(join(dir, 'db.json'), { runQueue: queue });
    const created = await platform.createCase({ name: 'listed', definition: passDefinition() });
    const live = await platform.createRun({ caseId: created.id });
    const finishing = await platform.createRun({ caseId: created.id });
    queue.claimNext();
    queue.claimNext();
    await platform.finishRun(finishing.id, { status: 'passed' });

    const queuedOnly = await platform.listRuns({ status: ['queued'] });
    assert.deepEqual(
      queuedOnly.map((run) => run.id),
      [],
    );
    assert.ok(queuedOnly.every((run) => run.status === 'queued'));

    const liveOnly = await platform.listRuns({ status: ['running', 'canceling', 'queued'] });
    assert.deepEqual(
      liveOnly.map((run) => run.id),
      [live.id],
    );
    assertPublicRun(liveOnly[0]!);

    const finishedOnly = await platform.listRuns({ status: ['passed', 'failed', 'canceled'] });
    assert.deepEqual(
      finishedOnly.map((run) => run.id),
      [finishing.id],
    );
    assertPublicRun(finishedOnly[0]!);

    const all = await platform.listRuns();
    assert.deepEqual(
      all.map((run) => run.id),
      [live.id, finishing.id],
    );
    const page = paginate(all, { limit: 1, offset: 1 });
    assert.equal(page.total, 2);
    assert.deepEqual(
      page.items.map((run) => run.id),
      [finishing.id],
    );

    const terminal = await platform.getRun(finishing.id);
    assert.equal(terminal.status, 'passed');
    assertPublicRun(terminal);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test('createRun copies the case definition into the memory queue only', async () => {
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
    const created = await platform.createCase({ name: 'smoke', definition: caseDef(original) });
    const run = await platform.createRun({ caseId: created.id });
    await platform.cancelRun(run.id);
    const next = await platform.updateCase(created.id, { name: 'edited', definition: caseDef(updated) });
    const live = await platform.createRun({ caseId: next.id });

    assert.equal(run.status, 'queued');
    assertPublicRun(run);
    assert.deepEqual(queue.get(live.id).definition, {
      main: 'Main',
      trees: { Main: updated },
    });
    assert.equal('definition' in (await platform.getRun(live.id)), false);
    assert.deepEqual((await platform.listRuns({ status: ['passed', 'failed', 'canceled'] }))[0]?.status, 'canceled');
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test('a run is persisted only after execution finishes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tp-'));
  try {
    const queue = createRunQueue();
    const platform = await platformWithTestAdapter(join(dir, 'db.json'), { runQueue: queue });
    const created = await platform.createCase({ name: 'smoke', definition: passDefinition() });
    const run = await platform.createRun({ caseId: created.id });
    queue.claimNext();

    const record = await platform.finishRun(run.id, { status: 'passed' });

    assert.equal(record.status, 'passed');
    assertPublicRun(record);
    assert.ok(record.finishedAt);
    assert.deepEqual(await platform.listRuns({ status: ['queued', 'running', 'canceling'] }), []);
    assert.equal((await platform.listRuns({ status: ['passed'] })).length, 1);

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
    const created = await platform.createCase({ name: 'cancel', definition: passDefinition() });
    const running = await platform.createRun({ caseId: created.id });
    const queued = await platform.createRun({ caseId: created.id });
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
    const created = await platform.createCase({ name: 'done', definition: passDefinition() });
    const run = await platform.createRun({ caseId: created.id });
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
      definition: passDefinition(),
    });

    await assert.rejects(
      () =>
        platform.updateCase(created.id, {
          name: 'mutated',
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
      definition: caseDef({ type: 'Action', capability: 'temporary.action', adapter: 'temporary', actor: 'robot' }),
    });
    const restarted = await createPlatform(file);

    await assert.rejects(
      () => restarted.createRun({ caseId: created.id }),
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
              definition: { extra: true },
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z',
            },
          ],
          runs: [],
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
              definition: {
                main: 'Main',
                trees: { Main: { type: 'Sequence', children: [] } },
              },
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z',
            },
          ],
          runs: [],
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

test('createRun initializes a pending tree and finishRun persists only trusted finalized progress', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tp-'));
  try {
    const queue = createRunQueue();
    const platform = await platformWithTestAdapter(join(dir, 'db.json'), { runQueue: queue });
    const created = await platform.createCase({
      name: 'trusted progress',
      definition: caseDef({
        type: 'Sequence',
        children: [
          { type: 'Action', capability: 'test.pass', adapter: 'test', actor: 'robot', ports: {} },
          { type: 'Action', capability: 'test.pass', adapter: 'test', actor: 'robot', ports: {} },
        ],
      }),
    });
    const run = await platform.createRun({ caseId: created.id });
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
      definition: passDefinition(),
    });
    const run = await platform.createRun({ caseId: created.id });
    await rm(file);
    await mkdir(file);

    await assert.rejects(() => platform.cancelRun(run.id));
    assert.equal((await platform.getRun(run.id)).status, 'queued');
    assert.equal(queue.get(run.id).status, 'queued');
    assert.deepEqual(await platform.listRuns({ status: ['canceled'] }), []);
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
      definition: passDefinition(),
    });
    const run = await platform.createRun({ caseId: created.id });
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
    assert.deepEqual(await platform.listRuns({ status: ['passed', 'failed', 'canceled'] }), []);
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
        runs: [],
        extra: true,
      }),
    );
    await assert.rejects(() => createPlatform(extraRoot));

    const extraRun = join(dir, 'extra-run.json');
    await writeFile(
      extraRun,
      JSON.stringify({
        cases: [],
        runs: [
          {
            id: 'run-1',
            caseId: 'case',
            status: 'passed',
            createdAt: '2026-09-09T00:00:00.000Z',
            startedAt: '2026-09-09T00:00:00.000Z',
            finishedAt: '2026-09-09T00:00:01.000Z',
            revision: 0,
            artifacts: [],
            tree: {
              main: 'Main',
              trees: {
                Main: {
                  type: 'Action',
                  adapter: 'test',
                  actor: 'robot',
                  capability: 'test.pass',
                  ports: {},
                  status: 'passed',
                  attempts: [],
                },
              },
            },
            extra: true,
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
      definition: passDefinition(),
    });
    const run = await platform.createRun({ caseId: created.id });
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
    assert.equal((await platform.listRuns({ status: ['canceled'] })).length, 1);
    assert.deepEqual(await platform.listRuns({ status: ['queued', 'running', 'canceling'] }), []);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});
