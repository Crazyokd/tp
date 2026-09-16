import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { findRunNode, httpRunSchema } from '@tp/contract';

import { setLogWrite } from '../src/log.ts';
import { createHttpServer, httpListenAddress } from '../src/server.ts';
import { manifest as secondTestManifest } from './fixtures/second-test-adapter.ts';
import { manifest as testManifest } from './fixtures/test-adapter.ts';
import { caseDef } from './case-def.ts';

const testAdapterModule = new URL('./fixtures/test-adapter.ts', import.meta.url).href;
const secondTestAdapterModule = new URL('./fixtures/second-test-adapter.ts', import.meta.url).href;

test('HTTP process binds 0.0.0.0 unless HOST is set', () => {
  assert.deepEqual(httpListenAddress({}), { host: '0.0.0.0', port: 3000 });
  assert.deepEqual(httpListenAddress({ HOST: '127.0.0.1', PORT: '4000' }), {
    host: '127.0.0.1',
    port: 4000,
  });
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

    const firstRun = await jsonFetch(`${base}/api/runs`, { method: 'POST', body: { caseId: firstCase.id } });
    const secondRun = await jsonFetch(`${base}/api/runs`, { method: 'POST', body: { caseId: secondCase.id } });
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
        definition: caseDef({
          type: 'Action',
          capability: 'test.pass',
          adapter: 'test',
          actor: 'robot',
          ports: { markerDir: { literal: dir } },
        }),
      },
    });
    const run = await jsonFetch(`${base}/api/runs`, { method: 'POST', body: { caseId: created.id } });
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
        definition: caseDef({ type: 'Action', capability: 'test.pass', adapter: 'test', actor: 'robot', ports: {} }),
      },
    });
    const hangingRun = await jsonFetch(`${base}/api/runs`, { method: 'POST', body: { caseId: hanging.id } });
    await waitForActiveProgress(base, hangingRun.id);
    const queuedRun = await jsonFetch(`${base}/api/runs`, { method: 'POST', body: { caseId: queuedCase.id } });
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
      body: { name: 'threaded', definition: created.definition },
    });
    assert.equal(updated.id, created.id);

    const run = await jsonFetch(`${base}/api/runs`, { method: 'POST', body: { caseId: created.id } });
    const records = await waitForFinished(base, 1);

    assert.equal(run.status, 'queued');
    assert.equal('workerId' in run, false);
    assert.equal(records[0].status, 'passed');
    assert.equal(records[0].id, run.id);
    const fetched = await jsonFetch(`${base}/api/runs/${run.id}`);
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
        definition: caseDef({
          type: 'Action',
          capability: 'test.pass',
          adapter: 'test',
          actor: 'robot',
          ports: { markerDir: { literal: dir }, delayMs: { literal: 100 } },
        }),
      },
    });
    const queued = await jsonFetch(`${base}/api/runs`, {
      method: 'POST',
      body: { caseId: created.id },
    });

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

test('HTTP API persists trusted failed-run progress from the real worker path', async () => {
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
        definition: caseDef({
          type: 'Action',
          capability: 'test.fail',
          adapter: 'test',
          actor: 'robot',
          ports: { markerDir: { literal: dir }, delayMs: { literal: 50 } },
        }),
      },
    });
    const run = await jsonFetch(`${base}/api/runs`, {
      method: 'POST',
      body: { caseId: created.id },
    });
    const active = await waitForActiveProgress(base, run.id);
    const [record] = await waitForFinished(base, 1);

    assert.equal(findRunNode(active.tree, '').status, 'running');
    assert.equal(record.status, 'failed');
    assert.equal(record.error, 'test.fail');
    assert.ok(typeof record.error === 'string' && record.error.trim().length > 0);
    assert.ok(record.revision > active.revision);
    assert.equal(findRunNode(record.tree, '').status, 'failed');
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
        definition: caseDef({
          type: 'Action',
          capability: 'test.record',
          adapter: 'test',
          actor: 'robot',
          ports: {},
        }),
      },
    });
    const run = await jsonFetch(`${base}/api/runs`, { method: 'POST', body: { caseId: created.id } });
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
      ['Adapters', 'Cases', 'Runs', 'Workers', 'Ops'],
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
    const run = await jsonFetch(`${base}/api/runs/${id}`);
    if (run.status === 'running' && run.revision >= 1) return run;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for active progress for ${id}`);
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
