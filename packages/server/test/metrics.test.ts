import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type { InstrumentSnapshot, Labels } from '@tp/metrics';

import { createAdapterRegistry } from '../src/adapter-registry.ts';
import { createServerMetrics } from '../src/metrics.ts';
import { createPlatform } from '../src/platform.ts';
import { createRunQueue } from '../src/run-queue.ts';
import { createHttpServer } from '../src/server.ts';
import { manifest as testManifest } from './fixtures/test-adapter.ts';
import { caseDef } from './case-def.ts';

const testAdapterModule = new URL('./fixtures/test-adapter.ts', import.meta.url).href;

function seriesValue(snapshot: InstrumentSnapshot[], name: string, labels: Labels = {}): number {
  const instrument = snapshot.find((item) => item.name === name);
  assert.ok(instrument, `missing metric ${name}`);
  const series = instrument.series.find((item) => sameLabels(item.labels, labels));
  assert.ok(series, `missing series ${name} ${JSON.stringify(labels)}`);
  return 'value' in series ? series.value : series.count;
}

function sameLabels(left: Labels, right: Labels): boolean {
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => left[key] === right[key]);
}

function passDefinition() {
  return caseDef({ type: 'Action', capability: 'test.pass', adapter: 'test', actor: 'robot', ports: {} });
}

test('platform and queue record case run and depth on one registry', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tp-metrics-'));
  const metrics = createServerMetrics();
  const registry = createAdapterRegistry();
  registry.register(testManifest);
  const runQueue = createRunQueue({ metrics });
  const platform = await createPlatform(join(dir, 'db.json'), { registry, runQueue, metrics });
  try {
    const created = await platform.createCase({ name: 'counted', definition: passDefinition() });
    await platform.updateCase(created.id, { name: 'counted', definition: passDefinition() });
    const run = await platform.createRun({ caseId: created.id });
    assert.equal(seriesValue(metrics.collect(), 'cases_total', { action: 'created' }), 1);
    assert.equal(seriesValue(metrics.collect(), 'cases_total', { action: 'updated' }), 1);
    assert.equal(seriesValue(metrics.collect(), 'run_queue_depth'), 1);

    runQueue.claimNext();
    const finished = await platform.finishRun(run.id, { status: 'passed' });
    assert.equal(finished.status, 'passed');
    assert.equal(seriesValue(metrics.collect(), 'runs_total', { status: 'passed' }), 1);
    assert.equal(seriesValue(metrics.collect(), 'run_queue_depth'), 0);
    assert.equal(seriesValue(metrics.collect(), 'run_seconds', { status: 'passed' }), 1);

    await platform.deleteCase(created.id);
    assert.equal(seriesValue(metrics.collect(), 'cases_total', { action: 'deleted' }), 1);

    const tight = createRunQueue({ capacity: 1, metrics });
    tight.enqueue({
      id: 'kept',
      caseId: created.id,
      status: 'queued',
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      revision: run.revision,
      tree: run.tree,
      artifacts: [],
      definition: passDefinition(),
    });
    assert.throws(() =>
      tight.enqueue({
        id: 'overflow',
        caseId: created.id,
        status: 'queued',
        createdAt: new Date().toISOString(),
        startedAt: null,
        finishedAt: null,
        revision: run.revision,
        tree: run.tree,
        artifacts: [],
        definition: passDefinition(),
      }),
    );
    assert.equal(seriesValue(metrics.collect(), 'run_queue_rejected_total'), 1);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test('HTTP API returns process metrics after a finished run', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tp-metrics-http-'));
  const server = await createHttpServer({
    dataFile: join(dir, 'db.json'),
    workspaceRoot: join(dir, 'runs'),
    adapterModules: [testAdapterModule],
    workerThreads: 1,
  });
  try {
    await listen(server);
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const created = await jsonFetch(`${base}/api/cases`, {
      method: 'POST',
      body: { name: 'scraped', definition: passDefinition() },
    });
    await jsonFetch(`${base}/api/runs`, { method: 'POST', body: { caseId: created.id } });
    await waitForFinished(base, 1);
    await errorFetch(`${base}/api/cases/missing`);

    const gone = await fetch(`${base}/metrics`);
    assert.equal(gone.status, 404);

    const response = await fetch(`${base}/api/metrics`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /application\/json/);
    const body = await response.json();
    assert.ok(Array.isArray(body.instruments));
    assert.equal(seriesValue(body.instruments, 'adapters_loaded_total', { adapter: 'test' }), 1);
    assert.equal(seriesValue(body.instruments, 'cases_total', { action: 'created' }), 1);
    assert.equal(seriesValue(body.instruments, 'runs_total', { status: 'passed' }), 1);
    assert.equal(seriesValue(body.instruments, 'http_requests_total', { operation: 'createCase', code: '201' }), 1);
    assert.equal(seriesValue(body.instruments, 'http_requests_total', { operation: 'createRun', code: '201' }), 1);
    assert.equal(seriesValue(body.instruments, 'http_requests_total', { operation: 'getCase', code: '404' }), 1);
    assert.ok(
      body.instruments.some(
        (item: { name: string; kind: string }) => item.name === 'run_seconds' && item.kind === 'histogram',
      ),
    );
    assert.equal(
      body.instruments.some(
        (item: { name: string }) => item.name === 'treeProgress' || item.name.includes('test.pass'),
      ),
      false,
    );
  } finally {
    await close(server);
    await rm(dir, { force: true, recursive: true });
  }
});

async function jsonFetch(url: string, options: { method?: string; body?: unknown } = {}) {
  const response = await fetch(url, {
    method: options.method,
    headers: { 'content-type': 'application/json' },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const body = await response.json();
  assert.ok(response.ok, JSON.stringify(body));
  return body;
}

async function errorFetch(url: string) {
  const response = await fetch(url);
  return { status: response.status, body: await response.json() };
}

async function waitForFinished(base: string, count: number) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const page = await jsonFetch(`${base}/api/runs`);
    const finished = page.items.filter(
      (item: { status: string }) => item.status === 'passed' || item.status === 'failed' || item.status === 'canceled',
    );
    if (finished.length >= count) return finished;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${count} finished runs`);
}

function listen(server: { listen: Function; once: Function }) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
}

function close(server: { close: Function }) {
  return new Promise((resolve) => server.close(resolve));
}
