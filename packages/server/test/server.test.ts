import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Worker } from 'node:worker_threads';

import { createRunTree, findRunNode, httpRunSchema } from '@tp/contract';

import { setLogWrite } from '../src/log.ts';
import { createHttpServer, httpListenAddress } from '../src/server.ts';
import { manifest as secondTestManifest } from './fixtures/second-test-adapter.ts';
import { manifest as testManifest } from './fixtures/test-adapter.ts';
import { caseDef } from './case-def.ts';

const testAdapterModule = new URL('./fixtures/test-adapter.ts', import.meta.url).href;
const seedAdapterModule = new URL('./fixtures/seed-adapter.ts', import.meta.url).href;
const secondTestAdapterModule = new URL('./fixtures/second-test-adapter.ts', import.meta.url).href;

test('HTTP process binds 0.0.0.0 unless HOST is set', () => {
  assert.deepEqual(httpListenAddress({}), { host: '0.0.0.0', port: 3000 });
  assert.deepEqual(httpListenAddress({ HOST: '127.0.0.1', PORT: '4000' }), {
    host: '127.0.0.1',
    port: 4000,
  });
});

test('server prunes runs after seven days at startup and hourly, and stops cleanup on close', async (context) => {
  const dir = await mkdtemp(join(tmpdir(), 'tp-'));
  const file = join(dir, 'db.json');
  const workspaceRoot = join(dir, 'runs');
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  context.mock.timers.enable({ apis: ['Date', 'setInterval'], now });
  const run = (id: string, finishedAt: number) => ({
    id,
    batchId: id,
    caseId: 'absent',
    status: 'passed',
    createdAt: new Date(now - 10 * day).toISOString(),
    startedAt: new Date(now - 10 * day).toISOString(),
    finishedAt: new Date(finishedAt).toISOString(),
    revision: 1,
    tree: createRunTree(
      caseDef({ type: 'Action', capability: 'test.pass', adapter: 'test', actor: 'robot', ports: {} }),
    ),
    artifacts: [],
  });
  await writeFile(
    file,
    JSON.stringify({
      cases: [],
      groups: [],
      batches: [run('expired', now - 7 * day - 1), run('boundary', now - 7 * day), run('recent', now)].map((run) => ({
        id: run.batchId,
        name: 'Stored Batch',
        description: '',
        trigger: { kind: 'web' },
        selection: { kind: 'cases' },
        createdAt: run.createdAt,
        runs: [run],
      })),
    }),
  );
  await mkdir(join(workspaceRoot, 'expired'), { recursive: true });
  await writeFile(join(workspaceRoot, 'expired', 'recording.webm'), 'video');
  const server = await createHttpServer({ dataFile: file, workspaceRoot, adapterModules: [testAdapterModule] });
  try {
    await listen(server);
    const base = `http://127.0.0.1:${server.address().port}`;
    assert.deepEqual(
      (await jsonFetch(`${base}/api/runs`)).items.map((item) => item.id),
      ['recent', 'boundary'],
    );
    await assert.rejects(() => readFile(join(workspaceRoot, 'expired', 'recording.webm')), { code: 'ENOENT' });
    context.mock.timers.tick(60 * 60 * 1000);
    assert.deepEqual(
      (await jsonFetch(`${base}/api/runs`)).items.map((item) => item.id),
      ['recent'],
    );
  } finally {
    await close(server);
  }
  try {
    const member = run('after-close', now - 8 * day);
    const data = {
      cases: [],
      groups: [],
      batches: [
        {
          name: 'Stored Batch',
          description: '',
          trigger: { kind: 'web' },
          selection: { kind: 'cases' },
          id: member.batchId,
          createdAt: member.createdAt,
          runs: [member],
        },
      ],
    };
    await writeFile(file, JSON.stringify(data));
    context.mock.timers.tick(60 * 60 * 1000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), data);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test('run retention accepts a configured day count and rejects invalid settings', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tp-'));
  const previous = process.env.TP_RUN_RETENTION_DAYS;
  try {
    const file = join(dir, 'db.json');
    for (const value of [0, -1, 0.5, NaN, Infinity]) {
      await assert.rejects(
        () => createHttpServer({ dataFile: file, runRetentionDays: value }),
        /run retention days must be a positive integer/,
      );
    }
    process.env.TP_RUN_RETENTION_DAYS = 'invalid';
    await assert.rejects(() => createHttpServer({ dataFile: file }), /run retention days must be a positive integer/);
    process.env.TP_RUN_RETENTION_DAYS = '2';
    const now = Date.now();
    const importedRun = {
      id: 'three-days-old',
      batchId: 'batch',
      caseId: 'absent',
      status: 'passed',
      createdAt: new Date(now - 4 * 86400000).toISOString(),
      startedAt: new Date(now - 4 * 86400000).toISOString(),
      finishedAt: new Date(now - 3 * 86400000).toISOString(),
      revision: 1,
      tree: createRunTree(
        caseDef({ type: 'Action', capability: 'test.pass', adapter: 'test', actor: 'robot', ports: {} }),
      ),
      artifacts: [],
    };
    const data = {
      cases: [],
      groups: [],
      batches: [
        {
          name: 'Stored Batch',
          description: '',
          trigger: { kind: 'web' },
          selection: { kind: 'cases' },
          id: importedRun.batchId,
          createdAt: importedRun.createdAt,
          runs: [importedRun],
        },
      ],
    };
    await writeFile(file, JSON.stringify(data));
    const server = await createHttpServer({ dataFile: file, workspaceRoot: join(dir, 'runs'), runRetentionDays: 4 });
    await close(server);
    assert.equal(JSON.parse(await readFile(file, 'utf8')).batches.length, 1);
    const shorter = await createHttpServer({ dataFile: file, workspaceRoot: join(dir, 'runs') });
    await close(shorter);
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).batches, []);
  } finally {
    if (previous === undefined) delete process.env.TP_RUN_RETENTION_DAYS;
    else process.env.TP_RUN_RETENTION_DAYS = previous;
    await rm(dir, { force: true, recursive: true });
  }
});

test('server waits for worker termination before reporting a retention cleanup error on close', async (context) => {
  const dir = await mkdtemp(join(tmpdir(), 'tp-'));
  const file = join(dir, 'db.json');
  const lines: string[] = [];
  const restore = setLogWrite((line) => lines.push(line));
  context.mock.timers.enable({ apis: ['setInterval'] });
  const server = await createHttpServer({ dataFile: file, workspaceRoot: join(dir, 'runs') });
  try {
    await listen(server);
    await rm(file);
    await mkdir(file);
    context.mock.timers.tick(60 * 60 * 1000);
    await jsonFetch(`http://127.0.0.1:${server.address().port}/api/runs`);
    assert.ok(lines.some((line) => line.includes('run retention cleanup failed')));
    let release: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const terminate = Worker.prototype.terminate;
    context.mock.method(Worker.prototype, 'terminate', function (this: Worker) {
      return gate.then(() => terminate.call(this));
    });
    let closed = false;
    const closing = new Promise<Error | undefined>((resolve) =>
      server.close((error) => {
        closed = true;
        resolve(error);
      }),
    );
    await new Promise((resolve) => setImmediate(resolve));
    const closedBeforeWorkers = closed;
    release!();
    const error = await closing;
    assert.equal((error as NodeJS.ErrnoException).code, 'EISDIR');
    assert.equal(closedBeforeWorkers, false);
    assert.ok(lines.some((line) => line.includes('worker pool closed')));
  } finally {
    if (server.listening) await close(server);
    restore();
    await rm(dir, { force: true, recursive: true });
  }
});

test('GET /api/adapters returns a page of adapters with nested capabilities and no moduleEntry', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tp-'));
  const server = await createHttpServer({
    dataFile: join(dir, 'db.json'),
    workspaceRoot: join(dir, 'runs'),
    adapterModules: [testAdapterModule],
  });
  try {
    await listen(server);
    const base = `http://127.0.0.1:${server.address().port}`;
    const page = await jsonFetch(`${base}/api/adapters`);

    assert.equal(page.total, 1);
    assert.equal(page.items.length, 1);
    assert.equal(page.items[0].id, 'test');
    assert.equal('moduleEntry' in page.items[0], false);
    assert.ok(page.items[0].capabilities.some((capability) => capability.key === 'test.pass'));
    assert.ok(page.items[0].capabilities.every((capability) => capability.adapter === 'test'));

    const missing = await errorFetch(`${base}/api/adapters/missing`);
    assert.equal(missing.status, 404);
    assert.equal(missing.body.code, 'not_found');

    const adapter = await jsonFetch(`${base}/api/adapters/test`);
    assert.equal(adapter.id, 'test');
    assert.equal('moduleEntry' in adapter, false);
  } finally {
    await close(server);
    await rm(dir, { force: true, recursive: true });
  }
});

test('unknown HTTP paths and one-sided pagination are invalid or not found', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tp-'));
  const server = await createHttpServer({ dataFile: join(dir, 'db.json'), workspaceRoot: join(dir, 'runs') });
  try {
    await listen(server);
    const base = `http://127.0.0.1:${server.address().port}`;

    const missing = await errorFetch(`${base}/api/nope`);
    assert.equal(missing.status, 404);
    assert.equal(missing.body.code, 'not_found');

    const invalid = await errorFetch(`${base}/api/cases?limit=10`);
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.code, 'invalid');
  } finally {
    await close(server);
    await rm(dir, { force: true, recursive: true });
  }
});

test('HTTP server registers and executes every configured built-in adapter module', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tp-'));
  const server = await createHttpServer({
    dataFile: join(dir, 'db.json'),
    workspaceRoot: join(dir, 'runs'),
    adapterModules: [testAdapterModule, secondTestAdapterModule],
  });
  try {
    await listen(server);
    const base = `http://127.0.0.1:${server.address().port}`;
    const adapters = await jsonFetch(`${base}/api/adapters`);
    const keys = adapters.items.flatMap((adapter) => adapter.capabilities.map((capability) => capability.key));

    assert.deepEqual(
      new Set(keys),
      new Set([
        ...testManifest.capabilities.map((capability) => capability.key),
        ...secondTestManifest.capabilities.map((capability) => capability.key),
      ]),
    );
    assert.equal(
      keys.some((key) => key.startsWith('demo.')),
      false,
    );
    const firstCase = await jsonFetch(`${base}/api/cases`, {
      method: 'POST',
      body: {
        name: 'first built-in',
        description: 'first built-in',

        definition: caseDef({
          type: 'Action',
          capability: 'test.pass',
          adapter: 'test',
          actor: 'robot',
          ports: { markerDir: { literal: dir } },
        }),
      },
    });
    const secondCase = await jsonFetch(`${base}/api/cases`, {
      method: 'POST',
      body: {
        name: 'second built-in',
        description: 'second built-in',

        definition: caseDef({
          type: 'Action',
          capability: 'second-test.pass',
          adapter: 'second-test',
          actor: 'robot',
          ports: {},
        }),
      },
    });
    const loaded = await jsonFetch(`${base}/api/cases/${firstCase.id}`);
    assert.equal(loaded.id, firstCase.id);

    const [firstRun] = (
      await jsonFetch(`${base}/api/batches`, {
        method: 'POST',
        body: { trigger: { kind: 'web' }, caseIds: [firstCase.id] },
      })
    ).runs;
    const [secondRun] = (
      await jsonFetch(`${base}/api/batches`, {
        method: 'POST',
        body: { trigger: { kind: 'web' }, caseIds: [secondCase.id] },
      })
    ).runs;
    assert.equal(firstRun.status, 'queued');
    assert.deepEqual(httpRunSchema.parse(firstRun), firstRun);
    const records = await waitForFinished(base, 2);

    assert.deepEqual(new Set(records.map(({ id }) => id)), new Set([firstRun.id, secondRun.id]));
    assert.ok(
      records.every(({ status }) => status === 'passed'),
      JSON.stringify(records),
    );
  } finally {
    await close(server);
    await rm(dir, { force: true, recursive: true });
  }
});

test('logs case and run lifecycle at info and stays quiet on list polls', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tp-'));
  const lines: string[] = [];
  const restore = setLogWrite((line) => lines.push(line));
  const server = await createHttpServer({
    dataFile: join(dir, 'db.json'),
    workspaceRoot: join(dir, 'runs'),
    adapterModules: [testAdapterModule],
    workerThreads: 1,
  });
  try {
    await listen(server);
    const base = `http://127.0.0.1:${server.address().port}`;
    const created = await jsonFetch(`${base}/api/cases`, {
      method: 'POST',
      body: {
        name: 'logged',
        description: 'logged',

        definition: caseDef({
          type: 'Action',
          capability: 'test.pass',
          adapter: 'test',
          actor: 'robot',
          ports: { markerDir: { literal: dir } },
        }),
      },
    });
    const [run] = (
      await jsonFetch(`${base}/api/batches`, {
        method: 'POST',
        body: { trigger: { kind: 'web' }, caseIds: [created.id] },
      })
    ).runs;
    await waitForFinished(base, 1);
    const afterLifecycle = infoLines(lines);
    const pollMark = lines.length;
    await jsonFetch(`${base}/api/runs`);
    await jsonFetch(`${base}/api/cases`);
    await jsonFetch(`${base}/api/workers`);
    assert.equal(infoLines(lines.slice(pollMark)).length, 0, lines.slice(pollMark).join('\n'));

    const text = afterLifecycle.join('\n');
    assert.match(text, /loaded adapter test/);
    assert.match(text, /created case .*logged/);
    assert.match(text, new RegExp(`created run ${run.id}`));
    assert.match(text, new RegExp(`finished run ${run.id} passed`));
    assert.ok(afterLifecycle.length < 30, afterLifecycle.join('\n'));

    await errorFetch(`${base}/api/cases/missing`);
    assert.ok(
      lines.some((line) => line.includes(' WARN ') && line.includes('not_found')),
      lines.join('\n'),
    );
  } finally {
    restore();
    await close(server);
    await rm(dir, { force: true, recursive: true });
  }
});

test('HTTP server fails fast when configured adapter modules are duplicated', async () => {
  await assert.rejects(
    () => createHttpServer({ adapterModules: [testAdapterModule, testAdapterModule] }),
    /adapter module .* is duplicated/,
  );
});

test('HTTP API cancels queued, running, and finished runs according to the status table', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tp-'));
  const server = await createHttpServer({
    dataFile: join(dir, 'db.json'),
    workspaceRoot: join(dir, 'runs'),
    adapterModules: [testAdapterModule],
    workerThreads: 1,
  });
  try {
    await listen(server);
    const base = `http://127.0.0.1:${server.address().port}`;
    const hanging = await jsonFetch(`${base}/api/cases`, {
      method: 'POST',
      body: {
        name: 'hanging',
        description: 'hanging',

        definition: caseDef({
          type: 'Action',
          capability: 'test.pass',
          adapter: 'test',
          actor: 'robot',
          ports: { delayMs: { literal: 60_000 } },
        }),
      },
    });
    const queuedCase = await jsonFetch(`${base}/api/cases`, {
      method: 'POST',
      body: {
        name: 'queued-cancel',
        description: 'queued-cancel',

        definition: caseDef({ type: 'Action', capability: 'test.pass', adapter: 'test', actor: 'robot', ports: {} }),
      },
    });
    const [hangingRun] = (
      await jsonFetch(`${base}/api/batches`, {
        method: 'POST',
        body: { trigger: { kind: 'web' }, caseIds: [hanging.id] },
      })
    ).runs;
    await waitForActiveProgress(base, hangingRun.id);
    const [queuedRun] = (
      await jsonFetch(`${base}/api/batches`, {
        method: 'POST',
        body: { trigger: { kind: 'web' }, caseIds: [queuedCase.id] },
      })
    ).runs;
    assert.equal(queuedRun.status, 'queued');

    const liveDelete = await errorFetch(`${base}/api/cases/${hanging.id}`, { method: 'DELETE' });
    assert.equal(liveDelete.status, 409);
    assert.equal(liveDelete.body.code, 'conflict');

    const queuedCancel = await jsonFetch(`${base}/api/runs/${queuedRun.id}/cancel`, { method: 'POST' });
    assert.equal(queuedCancel.status, 'canceled');
    assert.equal(queuedCancel.id, queuedRun.id);

    const runningCancel = await jsonFetch(`${base}/api/runs/${hangingRun.id}/cancel`, { method: 'POST' });
    assert.equal(runningCancel.status, 'canceling');

    const records = await waitForFinished(base, 2);
    assert.deepEqual(new Set(records.map((record) => record.status)), new Set(['canceled']));
    assert.deepEqual(new Set(records.map((record) => record.id)), new Set([hangingRun.id, queuedRun.id]));

    const finishedCancel = await errorFetch(`${base}/api/runs/${queuedRun.id}/cancel`, { method: 'POST' });
    assert.equal(finishedCancel.status, 409);
    assert.equal(finishedCancel.body.code, 'conflict');

    await jsonFetch(`${base}/api/cases/${hanging.id}`, { method: 'DELETE' });
    const gone = await errorFetch(`${base}/api/cases/${queuedCase.id}`, { method: 'DELETE' });
    assert.equal(gone.status, 204, JSON.stringify(gone));
  } finally {
    await close(server);
    await rm(dir, { force: true, recursive: true });
  }
});

test('HTTP server fails fast when a configured adapter module is invalid', async () => {
  await assert.rejects(
    () => createHttpServer({ adapterModules: [new URL('./fixtures/invalid-adapter.ts', import.meta.url).href] }),
    /too_small|adapter|id|moduleEntry/i,
  );
});

test('HTTP native Batch cancellation halts its running member and cancels queued members', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tp-'));
  const server = await createHttpServer({
    dataFile: join(dir, 'db.json'),
    workspaceRoot: join(dir, 'runs'),
    adapterModules: [testAdapterModule],
  });
  try {
    await listen(server);
    const base = `http://127.0.0.1:${server.address().port}`;
    const cases = [];
    for (const name of ['first', 'second']) {
      cases.push(
        await jsonFetch(`${base}/api/cases`, {
          method: 'POST',
          body: {
            name,
            description: name,
            definition: caseDef({
              type: 'Action',
              capability: 'test.pass',
              adapter: 'test',
              actor: 'robot',
              ports: { delayMs: { literal: 60_000 } },
            }),
          },
        }),
      );
    }
    const batch = await jsonFetch(`${base}/api/batches`, {
      method: 'POST',
      body: { trigger: { kind: 'web' }, caseIds: cases.map((item) => item.id) },
    });
    await waitForActiveProgress(base, batch.runs[0].id);
    assert.equal((await jsonFetch(`${base}/api/batches`)).total, 1);
    assert.equal((await jsonFetch(`${base}/api/batches/${batch.id}`)).runs.length, 2);
    const cancellation = await jsonFetch(`${base}/api/batches/${batch.id}/cancel`, { method: 'POST' });
    assert.equal(cancellation.counts.canceled + cancellation.counts.canceling, 2);
    await waitForFinished(base, 2);
    const finished = await jsonFetch(`${base}/api/batches/${batch.id}`);
    assert.equal(finished.status, 'canceled');
    assert.equal(finished.counts.canceled, 2);
    const slots = await jsonFetch(`${base}/api/workers`);
    assert.ok(slots.items.every((slot) => slot.state === 'idle'));
    assert.equal((await errorFetch(`${base}/api/runs`, { method: 'POST', body: { caseId: cases[0].id } })).status, 404);
  } finally {
    await close(server);
    await rm(dir, { recursive: true, force: true });
  }
});

test('HTTP API executes a configured adapter and keeps finished runs on GET /api/runs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tp-'));
  const server = await createHttpServer({
    dataFile: join(dir, 'db.json'),
    workspaceRoot: join(dir, 'runs'),
    adapterModules: [testAdapterModule],
  });
  try {
    await listen(server);
    const base = `http://127.0.0.1:${server.address().port}`;
    const created = await jsonFetch(`${base}/api/cases`, {
      method: 'POST',
      body: {
        name: 'threaded',
        description: 'threaded',

        definition: caseDef({
          type: 'Action',
          capability: 'test.pass',
          adapter: 'test',
          actor: 'robot',
          ports: { markerDir: { literal: dir } },
        }),
      },
    });
    const updated = await jsonFetch(`${base}/api/cases/${created.id}`, {
      method: 'PUT',
      body: { name: 'threaded', description: 'threaded', definition: created.definition },
    });
    assert.equal(updated.id, created.id);

    const [run] = (
      await jsonFetch(`${base}/api/batches`, {
        method: 'POST',
        body: { trigger: { kind: 'web' }, caseIds: [created.id] },
      })
    ).runs;
    const records = await waitForFinished(base, 1);

    assert.equal(run.status, 'queued');
    assert.equal('workerId' in run, false);
    assert.equal(records[0].status, 'passed');
    assert.equal(records[0].id, run.id);
    const fetched = await readFirstSseRun(`${base}/api/runs/${run.id}/events`);
    assert.equal(fetched.status, 'passed');
    const live = await jsonFetch(`${base}/api/runs?status=queued&status=running&status=canceling`);
    assert.deepEqual(live.items, []);
    assert.equal(live.total, 0);
  } finally {
    await close(server);
    await rm(dir, { force: true, recursive: true });
  }
});

test('HTTP API exposes live active progress and finished tree on the same Run', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tp-'));
  const server = await createHttpServer({
    dataFile: join(dir, 'db.json'),
    workspaceRoot: join(dir, 'runs'),
    adapterModules: [testAdapterModule],
  });
  try {
    await listen(server);
    const base = `http://127.0.0.1:${server.address().port}`;
    const created = await jsonFetch(`${base}/api/cases`, {
      method: 'POST',
      body: {
        name: 'live progress',
        description: 'live progress',

        definition: caseDef({
          type: 'Action',
          capability: 'test.pass',
          adapter: 'test',
          actor: 'robot',
          ports: { markerDir: { literal: dir }, delayMs: { literal: 100 } },
        }),
      },
    });
    const [queued] = (
      await jsonFetch(`${base}/api/batches`, {
        method: 'POST',
        body: { trigger: { kind: 'web' }, caseIds: [created.id] },
      })
    ).runs;

    assert.equal(queued.revision, 0);
    assert.equal(findRunNode(queued.tree, '').status, 'pending');
    const active = await waitForActiveProgress(base, queued.id);
    assert.equal(active.status, 'running');
    assert.ok(active.revision >= 1);
    assert.equal(findRunNode(active.tree, '').status, 'running');

    const [record] = await waitForFinished(base, 1);
    assert.equal(record.status, 'passed');
    assert.ok(record.revision > active.revision);
    assert.equal(findRunNode(record.tree, '').status, 'passed');
    assert.deepEqual(httpRunSchema.parse(record), record);
  } finally {
    await close(server);
    await rm(dir, { force: true, recursive: true });
  }
});

test('watchRun streams the current Run and later revisions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tp-'));
  const server = await createHttpServer({
    dataFile: join(dir, 'db.json'),
    workspaceRoot: join(dir, 'runs'),
    adapterModules: [testAdapterModule],
  });
  try {
    await listen(server);
    const base = `http://127.0.0.1:${server.address().port}`;
    const missing = await errorFetch(`${base}/api/runs/missing/events`);
    assert.equal(missing.status, 404);
    assert.equal(missing.body.code, 'not_found');
    const invalid = await errorFetch(`${base}/api/runs/missing/events`, { headers: { 'Last-Event-ID': '-1' } });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.code, 'invalid');

    const created = await jsonFetch(`${base}/api/cases`, {
      method: 'POST',
      body: {
        name: 'watch',
        description: 'watch',

        definition: caseDef({
          type: 'Action',
          capability: 'test.pass',
          adapter: 'test',
          actor: 'robot',
          ports: { markerDir: { literal: dir }, delayMs: { literal: 80 } },
        }),
      },
    });
    const [queued] = (
      await jsonFetch(`${base}/api/batches`, {
        method: 'POST',
        body: { trigger: { kind: 'web' }, caseIds: [created.id] },
      })
    ).runs;
    const first = await fetch(`${base}/api/runs/${queued.id}/events`);
    const second = await fetch(`${base}/api/runs/${queued.id}/events`);
    const firstRun = await readSseRun(first);
    const secondRun = await readSseRun(second);
    assert.equal(firstRun.id, queued.id);
    assert.deepEqual(firstRun, secondRun);
    const later = await Promise.race([
      readSseRun(first),
      new Promise((_, reject) => setTimeout(() => reject(new Error('no later frame')), 2000)),
    ]);
    assert.ok(later.revision > firstRun.revision);
    await first.body?.cancel();
    await second.body?.cancel();
    const finished = await readFirstSseRun(`${base}/api/runs/${queued.id}/events`);
    assert.ok(['queued', 'running', 'passed'].includes(finished.status));
  } finally {
    await close(server);
    await rm(dir, { force: true, recursive: true });
  }
});

test('HTTP API persists trusted failed-run progress without validating unwatched SSE snapshots', async (t) => {
  const safeParse = httpRunSchema.safeParse.bind(httpRunSchema);
  let snapshotValidations = 0;
  t.mock.method(httpRunSchema, 'safeParse', (...args) => {
    snapshotValidations += 1;
    return safeParse(...args);
  });
  const clone = globalThis.structuredClone;
  let progressTreeClones = 0;
  t.mock.method(globalThis, 'structuredClone', (value, options) => {
    if (value?.main && value?.trees) progressTreeClones += 1;
    return clone(value, options);
  });
  const dir = await mkdtemp(join(tmpdir(), 'tp-'));
  const server = await createHttpServer({
    dataFile: join(dir, 'db.json'),
    workspaceRoot: join(dir, 'runs'),
    adapterModules: [testAdapterModule],
  });
  try {
    await listen(server);
    const base = `http://127.0.0.1:${server.address().port}`;
    const created = await jsonFetch(`${base}/api/cases`, {
      method: 'POST',
      body: {
        name: 'failed progress',
        description: 'failed progress',

        definition: caseDef({
          type: 'Action',
          capability: 'test.fail',
          adapter: 'test',
          actor: 'robot',
          ports: { markerDir: { literal: dir }, delayMs: { literal: 50 } },
        }),
      },
    });
    const [run] = (
      await jsonFetch(`${base}/api/batches`, {
        method: 'POST',
        body: { trigger: { kind: 'web' }, caseIds: [created.id] },
      })
    ).runs;
    const active = await waitForActiveProgress(base, run.id);
    const [record] = await waitForFinished(base, 1);

    assert.equal(findRunNode(active.tree, '').status, 'running');
    assert.equal(record.status, 'failed');
    assert.equal(record.error, 'test.fail');
    assert.ok(typeof record.error === 'string' && record.error.trim().length > 0);
    assert.ok(record.revision > active.revision);
    assert.equal(findRunNode(record.tree, '').status, 'failed');
    assert.equal(snapshotValidations, 0);
    assert.equal(progressTreeClones, 1); // Finalization still clones the completed tree once.
  } finally {
    await close(server);
    await rm(dir, { force: true, recursive: true });
  }
});

test('GET /api/runs/:id/artifacts/:artifactId returns recorded bytes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tp-'));
  const server = await createHttpServer({
    dataFile: join(dir, 'db.json'),
    workspaceRoot: join(dir, 'runs'),
    adapterModules: [testAdapterModule],
    workerThreads: 1,
  });
  try {
    await listen(server);
    const base = `http://127.0.0.1:${server.address().port}`;
    const created = await jsonFetch(`${base}/api/cases`, {
      method: 'POST',
      body: {
        name: 'record',
        description: 'record',

        definition: caseDef({
          type: 'Action',
          capability: 'test.record',
          adapter: 'test',
          actor: 'robot',
          ports: {},
        }),
      },
    });
    const [run] = (
      await jsonFetch(`${base}/api/batches`, {
        method: 'POST',
        body: { trigger: { kind: 'web' }, caseIds: [created.id] },
      })
    ).runs;
    const [finished] = await waitForFinished(base, 1);
    assert.equal(finished.id, run.id);
    assert.equal(finished.status, 'passed');
    assert.equal(finished.artifacts.length, 1);
    const artifact = finished.artifacts[0];
    const response = await fetch(`${base}/api/runs/${run.id}/artifacts/${artifact.id}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/plain/);
    assert.match(response.headers.get('content-disposition') ?? '', /filename="note\.txt"/);
    assert.equal(await response.text(), 'ok');
    const missing = await errorFetch(`${base}/api/runs/${run.id}/artifacts/missing`);
    assert.equal(missing.status, 404);
    assert.equal(missing.body.code, 'not_found');
  } finally {
    await close(server);
    await rm(dir, { force: true, recursive: true });
  }
});

test('POST /api/batches/import stores a finished run and serves its artifact', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tp-'));
  const server = await createHttpServer({
    dataFile: join(dir, 'db.json'),
    workspaceRoot: join(dir, 'runs'),
    adapterModules: [testAdapterModule],
    workerThreads: 1,
  });
  try {
    await listen(server);
    const base = `http://127.0.0.1:${server.address().port}`;
    const importedRun = {
      id: 'imported',
      batchId: 'batch-imported',
      caseId: 'absent',
      status: 'passed',
      createdAt: '2026-11-10T00:00:00.000Z',
      startedAt: '2026-11-10T00:00:00.000Z',
      finishedAt: '2026-11-10T00:00:01.000Z',
      revision: 2,
      tree: createRunTree(
        caseDef({ type: 'Action', capability: 'test.pass', adapter: 'test', actor: 'robot', ports: {} }),
      ),
      artifacts: [{ id: 'art', name: 'steps.log', mediaType: 'text/plain' }],
    };
    const body = {
      name: 'Imported Batch',
      description: '',
      trigger: { kind: 'web' },
      selection: { kind: 'cases' },
      runs: [importedRun],
      files: [
        {
          runId: 'imported',
          artifactId: 'art',
          path: 'steps.log',
          contentBase64: Buffer.from('log').toString('base64'),
        },
      ],
    };
    const imported = await jsonFetch(`${base}/api/batches/import`, { method: 'POST', body });
    assert.equal(imported.runs.length, 1);
    assert.equal(imported.runs[0].id, 'imported');
    assert.equal(imported.runs[0].caseId, 'absent');
    const page = await jsonFetch(`${base}/api/runs`);
    assert.equal(
      page.items.some((item) => item.id === 'imported' && item.batchId === 'batch-imported'),
      true,
    );
    const artifact = await fetch(`${base}/api/runs/imported/artifacts/art`);
    assert.equal(artifact.status, 200);
    assert.equal(await artifact.text(), 'log');
    const conflict = await errorFetch(`${base}/api/batches/import`, { method: 'POST', body });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.code, 'conflict');
  } finally {
    await close(server);
    await rm(dir, { force: true, recursive: true });
  }
});

test('createRun seeds session blackboard keys and uses the port default', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tp-'));
  const server = await createHttpServer({
    dataFile: join(dir, 'db.json'),
    workspaceRoot: join(dir, 'runs'),
    adapterModules: [seedAdapterModule],
    workerThreads: 1,
  });
  try {
    await listen(server);
    const base = `http://127.0.0.1:${server.address().port}`;
    const definition = {
      main: 'Main',
      trees: {
        Main: { type: 'Condition', adapter: 'seed', actor: 'robot', capability: 'seed.ready' },
      },
      sessions: [
        {
          adapter: 'seed',
          actor: 'robot',
          ports: { label: { key: 'run.label' }, note: { key: 'run.note' } },
        },
      ],
    };
    const created = await jsonFetch(`${base}/api/cases`, {
      method: 'POST',
      body: { name: 'seeded', description: 'seeded', definition },
    });
    const [run] = (
      await jsonFetch(`${base}/api/batches`, {
        method: 'POST',
        body: { trigger: { kind: 'web' }, caseIds: [created.id], blackboard: { 'run.label': 'alpha' } },
      })
    ).runs;
    const [finished] = await waitForFinished(base, 1);
    assert.equal(finished.id, run.id);
    assert.equal(finished.status, 'passed');
    assert.equal(await readFile(join(dir, 'runs', run.id, 'session.txt'), 'utf8'), 'alpha\nfallback');

    const [missing] = (
      await jsonFetch(`${base}/api/batches`, {
        method: 'POST',
        body: { trigger: { kind: 'web' }, caseIds: [created.id] },
      })
    ).runs;
    const records = await waitForFinished(base, 2);
    const failed = records.find((item) => item.id === missing.id);
    assert.equal(failed.status, 'failed');
    assert.match(failed.error, /run\.label/);
  } finally {
    await close(server);
    await rm(dir, { force: true, recursive: true });
  }
});

test('HTTP API lists worker pool slots and returns a single worker', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tp-'));
  const server = await createHttpServer({
    dataFile: join(dir, 'db.json'),
    workspaceRoot: join(dir, 'runs'),
    workerThreads: 2,
  });
  try {
    await listen(server);
    const base = `http://127.0.0.1:${server.address().port}`;
    const workers = await waitForWorkerSlots(base, 2);

    assert.deepEqual(
      workers.map(({ id }) => id),
      ['worker-1', 'worker-2'],
    );
    assert.ok(workers.every((worker) => worker.runId === null));
    assert.ok(workers.every((worker) => ['starting', 'idle'].includes(worker.state)));
    const one = await jsonFetch(`${base}/api/workers/worker-1`);
    assert.equal(one.id, 'worker-1');
    const missing = await errorFetch(`${base}/api/workers/missing`);
    assert.equal(missing.status, 404);
    assert.equal(missing.body.code, 'not_found');
  } finally {
    await close(server);
    await rm(dir, { force: true, recursive: true });
  }
});

test('HTTP API rejects case capabilities that are not registered', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tp-'));
  const server = await createHttpServer({ dataFile: join(dir, 'db.json'), workspaceRoot: join(dir, 'runs') });
  try {
    await listen(server);
    const base = `http://127.0.0.1:${server.address().port}`;

    const response = await errorFetch(`${base}/api/cases`, {
      method: 'POST',
      body: {
        name: 'bad',
        description: 'bad',

        definition: caseDef({ type: 'Action', capability: 'missing.action', adapter: 'test', actor: 'robot' }),
      },
    });

    assert.equal(response.status, 400);
    assert.equal(response.body.code, 'invalid');
    assert.match(response.body.message, /capability test\/missing.action is not registered/);
  } finally {
    await close(server);
    await rm(dir, { force: true, recursive: true });
  }
});

test('HTTP server serves OpenAPI grouped by resource tags', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tp-'));
  const server = await createHttpServer({ dataFile: join(dir, 'db.json'), workspaceRoot: join(dir, 'runs') });
  try {
    await listen(server);
    const base = `http://127.0.0.1:${server.address().port}`;
    const spec = await jsonFetch(`${base}/openapi.json`);
    const swagger = await fetch(`${base}/swagger`);
    const html = await swagger.text();

    assert.deepEqual(
      spec.tags?.map((tag: { name: string }) => tag.name),
      ['Adapters', 'Cases', 'Groups', 'Runs', 'Batches', 'Workers', 'Ops'],
    );
    assert.deepEqual(spec.paths['/api/metrics'].get.tags, ['Ops']);
    assert.deepEqual(spec.paths['/api/runs'].get.tags, ['Runs']);
    assert.deepEqual(spec.paths['/api/workers'].get.tags, ['Workers']);
    assert.equal(swagger.status, 200);
    assert.match(html, /swagger-ui/);
    assert.match(html, /\/openapi\.json/);
  } finally {
    await close(server);
    await rm(dir, { force: true, recursive: true });
  }
});

test('HTTP server serves the app shell, architecture atlas, and archify', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tp-'));
  const publicDir = join(dir, 'public');
  await mkdir(join(publicDir, 'architecture-atlas'), { recursive: true });
  await mkdir(join(publicDir, 'archify'), { recursive: true });
  await writeFile(join(publicDir, 'index.html'), '<title>TP Test Platform</title><div id="root"></div>');
  await writeFile(join(publicDir, 'architecture-atlas/index.html'), '通用软件测试平台架构图');
  await writeFile(join(publicDir, 'archify/index.html'), 'TP 运行时边界');
  const server = await createHttpServer({
    dataFile: join(dir, 'db.json'),
    workspaceRoot: join(dir, 'runs'),
    publicDir,
  });
  try {
    await listen(server);
    const base = `http://127.0.0.1:${server.address().port}`;

    const appResponse = await fetch(`${base}/`);
    const appHtml = await appResponse.text();
    const atlasResponse = await fetch(`${base}/architecture-atlas/index.html`);
    const atlasHtml = await atlasResponse.text();
    const archifyResponse = await fetch(`${base}/archify/`);
    const archifyHtml = await archifyResponse.text();

    assert.equal(appResponse.status, 200);
    assert.match(appHtml, /TP Test Platform/);
    assert.match(appHtml, /<div id="root"><\/div>/);
    assert.equal(atlasResponse.status, 200);
    assert.match(atlasHtml, /通用软件测试平台架构图/);
    assert.equal(archifyResponse.status, 200);
    assert.match(archifyHtml, /TP 运行时边界/);

    const missing = await errorFetch(`${base}/missing.html`);
    assert.equal(missing.status, 404);
    assert.equal(missing.body.code, 'not_found');
    assert.equal(missing.body.message, 'not found');
  } finally {
    await close(server);
    await rm(dir, { force: true, recursive: true });
  }
});

test('HTTP server serves Vite React app assets', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tp-'));
  const publicDir = join(dir, 'public');
  await mkdir(join(publicDir, 'assets'), { recursive: true });
  await writeFile(join(publicDir, 'index.html'), '<script type="module" src="/assets/app.js"></script>');
  await writeFile(join(publicDir, 'assets/app.js'), 'window.ReactFlow = true;');
  const server = await createHttpServer({
    dataFile: join(dir, 'db.json'),
    workspaceRoot: join(dir, 'runs'),
    publicDir,
  });
  try {
    await listen(server);
    const base = `http://127.0.0.1:${server.address().port}`;

    const htmlResponse = await fetch(`${base}/`);
    const html = await htmlResponse.text();
    const assetPath = html.match(/src="([^"]+\.js)"/)?.[1];
    assert.ok(assetPath);

    const scriptResponse = await fetch(`${base}${assetPath}`);
    const script = await scriptResponse.text();

    assert.equal(scriptResponse.status, 200);
    assert.match(script, /ReactFlow|react-flow|xyflow/i);
  } finally {
    await close(server);
    await rm(dir, { force: true, recursive: true });
  }
});

async function waitForFinished(base, count) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const page = await jsonFetch(`${base}/api/runs`);
    const finished = page.items.filter((run) => ['passed', 'failed', 'canceled'].includes(run.status));
    if (finished.length >= count) return finished;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${count} finished runs`);
}

async function waitForWorkerSlots(base, count) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await fetch(`${base}/api/workers`);
    if (response.ok) {
      const page = await response.json();
      if (Array.isArray(page.items) && page.items.length === count) return page.items;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${count} worker slots`);
}

async function waitForActiveProgress(base, id) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const page = await jsonFetch(`${base}/api/runs`);
    const found = page.items.find((item) => item.id === id);
    if (found?.status === 'running' && found.revision >= 1) return found;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for active progress for ${id}`);
}

async function readFirstSseRun(url, headers = {}) {
  const response = await fetch(url, { headers });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
  const run = await readSseRun(response);
  await response.body?.cancel();
  return run;
}

async function readSseRun(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = response._sseBuffer ?? '';
  try {
    while (true) {
      const taken = takeSseRun(buffer);
      if (taken) {
        response._sseBuffer = taken.rest;
        return taken.run;
      }
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
  throw new Error('sse stream ended before a run event');
}

function takeSseRun(buffer) {
  let rest = buffer;
  let separator = rest.indexOf('\n\n');
  while (separator >= 0) {
    const block = rest.slice(0, separator);
    rest = rest.slice(separator + 2);
    if (block === '' || block.startsWith(':')) {
      separator = rest.indexOf('\n\n');
      continue;
    }
    const data = block
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => line.slice(6))
      .join('\n');
    const id = block
      .split('\n')
      .find((line) => line.startsWith('id: '))
      ?.slice(4);
    const parsed = httpRunSchema.parse(JSON.parse(data));
    assert.equal(id, String(parsed.revision));
    return { run: parsed, rest };
  }
  return undefined;
}

async function jsonFetch(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (response.status === 204) {
    assert.equal(await response.text(), '');
    return undefined;
  }
  const body = await response.json();
  if (!response.ok) {
    assert.equal(Object.hasOwn(body, 'code'), true, JSON.stringify(body));
    assert.equal(Object.hasOwn(body, 'error'), false, JSON.stringify(body));
    assert.ok(false, `${body.code}: ${body.message}`);
  }
  return body;
}

async function errorFetch(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (response.status === 204) {
    return { status: 204, body: undefined };
  }
  const body = await response.json();
  assert.equal(typeof body.code, 'string', JSON.stringify(body));
  assert.equal(typeof body.message, 'string', JSON.stringify(body));
  assert.equal(Object.hasOwn(body, 'error'), false, JSON.stringify(body));
  return { status: response.status, body };
}

function infoLines(lines: string[]): string[] {
  return lines.filter((line) => line.includes(' INFO '));
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

test('Group HTTP CRUD shares Case references and enqueues one native batch', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tp-group-http-'));
  const server = await createHttpServer({
    dataFile: join(dir, 'db.json'),
    workspaceRoot: join(dir, 'runs'),
    adapterModules: [testAdapterModule],
    workerThreads: 2,
  });
  try {
    await listen(server);
    const base = `http://127.0.0.1:${server.address().port}`;
    const shared = await jsonFetch(`${base}/api/cases`, {
      method: 'POST',
      body: {
        name: 'shared',
        description: 'shared',
        definition: caseDef({ type: 'Action', adapter: 'test', actor: 'robot', capability: 'test.pass', ports: {} }),
      },
    });
    const wide = await jsonFetch(`${base}/api/groups`, {
      method: 'POST',
      body: { name: 'inttest', caseIds: [shared.id] },
    });
    const http = await jsonFetch(`${base}/api/groups`, {
      method: 'POST',
      body: { name: 'http', caseIds: [shared.id] },
    });
    assert.equal((await jsonFetch(`${base}/api/groups?limit=1&offset=1`)).total, 2);
    assert.deepEqual((await jsonFetch(`${base}/api/groups/${http.id}`)).caseIds, [shared.id]);
    const referenced = await errorFetch(`${base}/api/cases/${shared.id}`, { method: 'DELETE' });
    assert.equal(referenced.status, 409);
    assert.match(referenced.body.message, /inttest.*http/);
    assert.equal(
      (
        await errorFetch(`${base}/api/groups`, {
          method: 'POST',
          body: { name: 'duplicate', caseIds: [shared.id, shared.id] },
        })
      ).status,
      400,
    );
    assert.equal(
      (await errorFetch(`${base}/api/cases`, { method: 'POST', body: { ...shared, group: 'old' } })).status,
      400,
    );
    const [run] = (
      await jsonFetch(`${base}/api/batches`, { method: 'POST', body: { trigger: { kind: 'web' }, groupId: http.id } })
    ).runs;
    assert.equal(run.caseId, shared.id);
    assert.ok(run.batchId);
    await jsonFetch(`${base}/api/groups/${http.id}`, { method: 'PUT', body: { name: 'http', caseIds: [] } });
    assert.equal(
      (
        await errorFetch(`${base}/api/batches`, {
          method: 'POST',
          body: { trigger: { kind: 'web' }, groupId: http.id },
        })
      ).status,
      400,
    );
    const finished = await waitForFinished(base, 1);
    assert.equal(finished[0].status, 'passed');
    assert.equal(finished[0].batchId, run.batchId);
    await jsonFetch(`${base}/api/groups/${http.id}`, { method: 'DELETE' });
    await jsonFetch(`${base}/api/groups/${wide.id}`, { method: 'DELETE' });
    assert.equal((await jsonFetch(`${base}/api/cases`)).items.length, 1);
    assert.equal((await jsonFetch(`${base}/api/runs`)).items.length, 1);
    await jsonFetch(`${base}/api/cases/${shared.id}`, { method: 'DELETE' });
  } finally {
    await close(server);
    await rm(dir, { force: true, recursive: true });
  }
});
