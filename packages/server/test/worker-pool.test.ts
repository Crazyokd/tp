import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Worker } from 'node:worker_threads';

import { createRunTree, findRunNode } from '@tp/contract';

import { createAdapterRegistry } from '../src/adapter-registry.ts';
import { createPlatform } from '../src/platform.ts';
import { createRunQueue } from '../src/run-queue.ts';
import { cleanupAdapterSessions, DEFAULT_SESSION_CLEANUP_TIMEOUT_MS } from '../src/session-cleanup.ts';
import { createWorkerPool } from '../src/worker-pool.ts';
import { manifest as testManifest } from './fixtures/test-adapter.ts';
import { caseDef } from './case-def.ts';

class FakeWorker extends EventEmitter {
  posted = [];

  postMessage(message) {
    this.posted.push(message);
  }

  async terminate() {
    this.emit('exit', 1);
    return 1;
  }

  send(message) {
    this.emit('message', message);
  }
}

function adapterWorkspace(runId: string) {
  return join(tmpdir(), 'tp-test', runId);
}

function fakeQueuedRun(id) {
  const definition = caseDef({ type: 'Action', capability: 'test.fake', adapter: 'test', actor: 'robot' });
  return {
    id,
    batchId: `batch-${id}`,
    caseId: `case-${id}`,
    status: 'queued',
    createdAt: '2026-09-10T00:00:00.000Z',
    startedAt: null,
    finishedAt: null,
    revision: 0,
    tree: createRunTree(definition),
    artifacts: [],
    definition,
  };
}

test('a worker records progress without cloning unrelated trees and cleans up its adapter session', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tp-pool-'));
  const registry = createAdapterRegistry();
  const queue = createRunQueue();
  registry.register(testManifest);
  const platform = await createPlatform(join(dir, 'db.json'), { registry, runQueue: queue });
  let resolveRecord;
  const completed = new Promise((resolve) => {
    resolveRecord = resolve;
  });
  const messageOrder: string[] = [];
  const pool = createWorkerPool({
    size: 1,
    registry,
    runQueue: queue,
    workspaceRoot: join(dir, 'runs'),
    workerFactory: (url) =>
      new Worker(
        new URL(
          `data:text/javascript,${encodeURIComponent(`
            const clone = globalThis.structuredClone;
            globalThis.structuredClone = (value, options) => {
              if (value?.main && value?.trees) throw new Error('progress must not clone the entire Run tree');
              return clone(value, options);
            };
            await import(${JSON.stringify(url.href)});
          `)}`,
        ),
      ),
    onProgress: (runId, event) => {
      messageOrder.push(`progress:${event.revision}`);
      queue.applyProgress(runId, event);
    },
    onResult: async (runId, result) => {
      messageOrder.push('result');
      resolveRecord(await platform.finishRun(runId, result));
    },
  });

  try {
    pool.start();
    const created = await platform.createCase({
      name: 'threaded',
      description: 'threaded',

      definition: caseDef({
        main: 'Main',
        trees: {
          Main: {
            type: 'Action',
            capability: 'test.pass',
            adapter: 'test',
            actor: 'robot1',
            ports: { markerDir: { literal: dir } },
          },
          Unused: {
            type: 'Sequence',
            children: Array.from({ length: 1000 }, () => ({
              type: 'Action',
              capability: 'test.pass',
              adapter: 'test',
              actor: 'robot1',
            })),
          },
        },
      }),
    });
    const [run] = (await platform.createBatch({ trigger: { kind: 'web' }, caseIds: [created.id] })).runs;
    const record = await completed;

    assert.equal(record.id, run.id);
    assert.equal(record.status, 'passed', record.error);
    assert.ok(record.revision > 0);
    assert.equal(findRunNode(record.tree, '').status, 'passed');
    assert.equal(messageOrder.at(-1), 'result');
    assert.ok(messageOrder.slice(0, -1).every((entry) => entry.startsWith('progress:')));
    assert.match(await readFile(join(dir, 'events.log'), 'utf8'), /execute:robot1/);
    assert.equal(await readFile(join(adapterWorkspace(run.id), 'cleanup.log'), 'utf8'), 'cleanup\n');
  } finally {
    await pool.close();
    await rm(dir, { force: true, recursive: true });
  }
});

test('ParallelAll with two actors creates two adapter sessions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tp-pool-actors-'));
  const registry = createAdapterRegistry();
  const queue = createRunQueue();
  registry.register(testManifest);
  const platform = await createPlatform(join(dir, 'db.json'), { registry, runQueue: queue });
  let resolveRecord;
  const completed = new Promise((resolve) => {
    resolveRecord = resolve;
  });
  const pool = createWorkerPool({
    size: 1,
    registry,
    runQueue: queue,
    workspaceRoot: join(dir, 'runs'),
    onProgress: (runId, event) => {
      queue.applyProgress(runId, event);
    },
    onResult: async (runId, result) => {
      resolveRecord(await platform.finishRun(runId, result));
    },
  });

  try {
    pool.start();
    const created = await platform.createCase({
      name: 'two-actors',
      description: 'two-actors',

      definition: caseDef({
        type: 'ParallelAll',
        children: [
          { type: 'Action', capability: 'test.pass', adapter: 'test', actor: 'r1' },
          { type: 'Action', capability: 'test.pass', adapter: 'test', actor: 'r2' },
        ],
      }),
    });
    const [run] = (await platform.createBatch({ trigger: { kind: 'web' }, caseIds: [created.id] })).runs;
    const record = await completed;

    assert.equal(record.status, 'passed');
    assert.deepEqual(
      (await readFile(join(adapterWorkspace(run.id), 'session.log'), 'utf8')).trim().split('\n').sort(),
      ['session:r1', 'session:r2'],
    );
    assert.deepEqual((await readFile(join(adapterWorkspace(run.id), 'events.log'), 'utf8')).trim().split('\n').sort(), [
      'execute:r1',
      'execute:r2',
    ]);
  } finally {
    await pool.close();
    await rm(dir, { force: true, recursive: true });
  }
});

test('adapter execution errors fail the run without crashing the worker thread', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tp-pool-'));
  const registry = createAdapterRegistry();
  const queue = createRunQueue();
  registry.register(testManifest);
  const platform = await createPlatform(join(dir, 'db.json'), { registry, runQueue: queue });
  let resolveRecord;
  const completed = new Promise((resolve) => {
    resolveRecord = resolve;
  });
  const pool = createWorkerPool({
    size: 1,
    registry,
    runQueue: queue,
    workspaceRoot: join(dir, 'runs'),
    onProgress: (runId, event) => {
      queue.applyProgress(runId, event);
    },
    onResult: async (runId, result) => {
      resolveRecord(await platform.finishRun(runId, result));
    },
  });

  try {
    pool.start();
    const created = await platform.createCase({
      name: 'failure',
      description: 'failure',

      definition: caseDef({
        type: 'Action',
        capability: 'test.fail',
        adapter: 'test',
        actor: 'robot',
        ports: { markerDir: { literal: dir } },
      }),
    });
    await platform.createBatch({ trigger: { kind: 'web' }, caseIds: [created.id] });

    const record = await completed;

    assert.equal(record.status, 'failed');
    assert.equal(pool.size(), 1);
  } finally {
    await pool.close();
    await rm(dir, { force: true, recursive: true });
  }
});

test('adapter results that violate the contract fail the run', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tp-pool-'));
  const registry = createAdapterRegistry();
  const queue = createRunQueue();
  registry.register(testManifest);
  const platform = await createPlatform(join(dir, 'db.json'), { registry, runQueue: queue });
  let resolveRecord;
  const completed = new Promise((resolve) => {
    resolveRecord = resolve;
  });
  const pool = createWorkerPool({
    size: 1,
    registry,
    runQueue: queue,
    workspaceRoot: join(dir, 'runs'),
    onProgress: (runId, event) => {
      queue.applyProgress(runId, event);
    },
    onResult: async (runId, result) => {
      resolveRecord(await platform.finishRun(runId, result));
    },
    onRunFatal: async (runId, result) => {
      resolveRecord(await platform.finishRun(runId, result));
    },
    onFatal: () => undefined,
  });

  try {
    pool.start();
    const created = await platform.createCase({
      name: 'invalid adapter',
      description: 'invalid adapter',

      definition: caseDef({
        type: 'Action',
        capability: 'test.invalid',
        adapter: 'test',
        actor: 'robot',
        ports: { markerDir: { literal: dir } },
      }),
    });
    await platform.createBatch({ trigger: { kind: 'web' }, caseIds: [created.id] });

    const record = await completed;

    assert.equal(record.status, 'failed');
    assert.match(String(record.error), /invalid result status|output does not match/);
  } finally {
    await pool.close();
    await rm(dir, { force: true, recursive: true });
  }
});

test('failed adapter output must still match its declared output schema', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tp-pool-'));
  const registry = createAdapterRegistry();
  const queue = createRunQueue();
  registry.register(testManifest);
  const platform = await createPlatform(join(dir, 'db.json'), { registry, runQueue: queue });
  const completed = new Promise<Awaited<ReturnType<typeof platform.finishRun>>>((resolve) => {
    const pool = createWorkerPool({
      size: 1,
      registry,
      runQueue: queue,
      workspaceRoot: join(dir, 'runs'),
      onProgress: (runId, event) => {
        queue.applyProgress(runId, event);
      },
      onResult: async (runId, result) => {
        resolve(await platform.finishRun(runId, result));
        await pool.close();
      },
      onRunFatal: async (runId, result) => {
        resolve(await platform.finishRun(runId, result));
        await pool.close();
      },
      onFatal: () => undefined,
    });
    pool.start();
  });

  try {
    const created = await platform.createCase({
      name: 'failed invalid output',
      description: 'failed invalid output',

      definition: caseDef({
        type: 'Action',
        capability: 'test.failed-invalid-output',
        adapter: 'test',
        actor: 'robot',
        ports: {},
      }),
    });
    await platform.createBatch({ trigger: { kind: 'web' }, caseIds: [created.id] });
    const record = await completed;
    assert.equal(record.status, 'failed');
    assert.match(String(record.error), /output port ok does not match schema/);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test('passed adapter result may omit optional output ports', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tp-pool-'));
  const registry = createAdapterRegistry();
  const queue = createRunQueue();
  registry.register(testManifest);
  const platform = await createPlatform(join(dir, 'db.json'), { registry, runQueue: queue });
  let resolveRecord;
  const completed = new Promise((resolve) => {
    resolveRecord = resolve;
  });
  const pool = createWorkerPool({
    size: 1,
    registry,
    runQueue: queue,
    workspaceRoot: join(dir, 'runs'),
    onProgress: (runId, event) => {
      queue.applyProgress(runId, event);
    },
    onResult: async (runId, result) => {
      resolveRecord(await platform.finishRun(runId, result));
    },
  });

  try {
    pool.start();
    const created = await platform.createCase({
      name: 'passed missing output',
      description: 'passed missing output',

      definition: caseDef({
        type: 'Action',
        capability: 'test.passed-missing-output',
        adapter: 'test',
        actor: 'robot',
        ports: {},
      }),
    });
    await platform.createBatch({ trigger: { kind: 'web' }, caseIds: [created.id] });
    const record = await completed;
    assert.equal(record.status, 'passed');
  } finally {
    await pool.close();
    await rm(dir, { force: true, recursive: true });
  }
});

test('worker converts malicious result.error values into cloneable contract failures', async (t) => {
  for (const capability of ['test.failed-function-error']) {
    await t.test(capability, async () => {
      const dir = await mkdtemp(join(tmpdir(), 'tp-pool-'));
      const registry = createAdapterRegistry();
      const queue = createRunQueue();
      registry.register(testManifest);
      const platform = await createPlatform(join(dir, 'db.json'), { registry, runQueue: queue });
      let resolveRecord;
      const completed = new Promise((resolve) => {
        resolveRecord = resolve;
      });
      const pool = createWorkerPool({
        size: 1,
        registry,
        runQueue: queue,
        workspaceRoot: join(dir, 'runs'),
        onProgress: (runId, event) => {
          queue.applyProgress(runId, event);
        },
        onResult: async (runId, result) => {
          resolveRecord(await platform.finishRun(runId, result));
        },
        onRunFatal: async (runId, result) => {
          resolveRecord(await platform.finishRun(runId, result));
        },
        onFatal: () => undefined,
      });
      try {
        pool.start();
        const created = await platform.createCase({
          name: capability,
          description: 'test',

          definition: caseDef({ type: 'Action', adapter: 'test', actor: 'robot', capability, ports: {} }),
        });
        await platform.createBatch({ trigger: { kind: 'web' }, caseIds: [created.id] });
        const record = await completed;
        assert.equal(record.status, 'failed');
        assert.match(String(record.error), /not cloneable/);
      } finally {
        await pool.close();
        await rm(dir, { force: true, recursive: true });
      }
    });
  }
});

test('Timeout halt finishes the run and still cleans the adapter session', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tp-pool-timeout-cleanup-'));
  const registry = createAdapterRegistry();
  const queue = createRunQueue();
  registry.register(testManifest);
  const platform = await createPlatform(join(dir, 'db.json'), { registry, runQueue: queue });
  let resolveRecord!: (record: Awaited<ReturnType<typeof platform.finishRun>>) => void;
  const completed = new Promise<Awaited<ReturnType<typeof platform.finishRun>>>((resolve) => {
    resolveRecord = resolve;
  });
  const order: string[] = [];
  const pool = createWorkerPool({
    size: 1,
    registry,
    runQueue: queue,
    workspaceRoot: join(dir, 'runs'),
    sessionCleanupTimeoutMs: 20,
    onProgress: (runId, event) => {
      queue.applyProgress(runId, event);
    },
    onResult: async (runId, result) => {
      order.push('result');
      resolveRecord(await platform.finishRun(runId, result));
    },
    onFatal: () => {
      order.push('host-fatal');
    },
  });
  try {
    pool.start();
    const created = await platform.createCase({
      name: 'timeout cleanup',
      description: 'timeout cleanup',

      definition: caseDef({
        type: 'Timeout',
        msec: 1,
        child: { type: 'Action', capability: 'test.worker-fatal', adapter: 'test', actor: 'robot', ports: {} },
      }),
    });
    const [run] = (await platform.createBatch({ trigger: { kind: 'web' }, caseIds: [created.id] })).runs;
    const record = await completed;
    assert.equal(await readFile(join(adapterWorkspace(run.id), 'cleanup.log'), 'utf8'), 'cleanup\n');
    assert.equal(record.status, 'failed');
    assert.equal(findRunNode(record.tree, '').status, 'failed');
    assert.ok(typeof record.error === 'string' && record.error.trim().length > 0);
    assert.deepEqual(order, ['result']);
  } finally {
    await pool.close();
    await rm(dir, { force: true, recursive: true });
  }
});

test('worker cleanup stops at a hanging consumer under one shared deadline', async () => {
  const starts: Array<{ id: number; at: number }> = [];
  const sessions = [1, 2].map((id) => ({
    async tick() {
      return { status: 'SUCCESS' as const };
    },
    async halt() {},
    async cleanup() {
      starts.push({ id, at: Date.now() });
      return new Promise<void>(() => undefined);
    },
  }));
  const startedAt = Date.now();
  const errors = await cleanupAdapterSessions(sessions, { timeoutMs: 20 });
  const elapsed = Date.now() - startedAt;

  assert.deepEqual(
    starts.map(({ id }) => id),
    [2],
  );
  assert.ok(elapsed >= 15 && elapsed < 100, `shared cleanup deadline elapsed=${elapsed}ms`);
  assert.deepEqual(errors, ['session cleanup timed out after 20ms']);
});

test('worker pool forwards sessionCleanupTimeoutMs only when configured', async (t) => {
  for (const scenario of [
    { configured: undefined, expected: undefined },
    { configured: 123_000, expected: 123_000 },
  ]) {
    await t.test(`configured=${String(scenario.configured)}`, async () => {
      const worker = new FakeWorker();
      const queue = createRunQueue();
      queue.enqueue(fakeQueuedRun('run'));
      const pool = createWorkerPool({
        size: 1,
        registry: createAdapterRegistry(),
        runQueue: queue,
        workspaceRoot: '/tmp',
        ...(scenario.configured === undefined ? {} : { sessionCleanupTimeoutMs: scenario.configured }),
        workerFactory: () => worker as unknown as Worker,
        onProgress: (runId, event) => {
          queue.applyProgress(runId, event);
        },
        onResult: async () => undefined,
        onFatal: () => undefined,
      });
      pool.start();
      worker.send({ type: 'ready' });
      await new Promise((resolve) => setImmediate(resolve));
      const runMessage = worker.posted.find(({ type }) => type === 'run');
      assert.ok(runMessage);
      assert.equal(runMessage.sessionCleanupTimeoutMs, scenario.expected);
      await pool.close();
    });
  }
});

test('default session cleanup budget covers docker stop grace periods', () => {
  assert.ok(DEFAULT_SESSION_CLEANUP_TIMEOUT_MS >= 60_000);
});

test('hanging session cleanup after Timeout is bounded', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tp-pool-timeout-hanging-cleanup-'));
  const registry = createAdapterRegistry();
  const queue = createRunQueue();
  registry.register(testManifest);
  const platform = await createPlatform(join(dir, 'db.json'), { registry, runQueue: queue });
  let resolveRecord!: (record: Awaited<ReturnType<typeof platform.finishRun>>) => void;
  const completed = new Promise<Awaited<ReturnType<typeof platform.finishRun>>>((resolve) => {
    resolveRecord = resolve;
  });
  const pool = createWorkerPool({
    size: 1,
    registry,
    runQueue: queue,
    workspaceRoot: join(dir, 'runs'),
    sessionCleanupTimeoutMs: 20,
    onProgress: (runId, event) => {
      queue.applyProgress(runId, event);
    },
    onResult: async (runId, result) => {
      resolveRecord(await platform.finishRun(runId, result));
    },
  });
  try {
    pool.start();
    const created = await platform.createCase({
      name: 'timeout hanging cleanup',
      description: 'timeout hanging cleanup',

      definition: caseDef({
        type: 'Timeout',
        msec: 1,
        child: {
          type: 'Action',
          capability: 'test.worker-fatal-hanging-cleanup',
          adapter: 'test',
          actor: 'robot',
          ports: {},
        },
      }),
    });
    await platform.createBatch({ trigger: { kind: 'web' }, caseIds: [created.id] });
    const startedAt = Date.now();
    const record = await completed;
    assert.ok(Date.now() - startedAt < 3_000);
    assert.equal(record.status, 'failed');
    assert.match(String(record.error), /cleanup.*timed out.*20ms/i);
  } finally {
    await pool.close();
    await rm(dir, { force: true, recursive: true });
  }
});

test('worker pool rejects unassigned, wrong-run, and duplicate-revision progress as fatal protocol errors', async (t) => {
  for (const scenario of ['unassigned', 'wrong-run', 'duplicate-revision']) {
    await t.test(scenario, async () => {
      const worker = new FakeWorker();
      const queue = createRunQueue();
      if (scenario !== 'unassigned') queue.enqueue(fakeQueuedRun('assigned'));
      const fatalErrors = [];
      const pool = createWorkerPool({
        size: 1,
        registry: createAdapterRegistry(),
        runQueue: queue,
        workspaceRoot: '/tmp',
        workerFactory: () => worker as unknown as Worker,
        onProgress: (runId, event) => {
          queue.applyProgress(runId, event);
        },
        onResult: async () => undefined,
        onRunFatal: async () => undefined,
        onFatal: (error) => fatalErrors.push(error),
      });
      pool.start();
      worker.send({ type: 'ready' });
      const event = {
        revision: 1,
        kind: 'started',
        path: '',
        nodeType: 'Action',
        capability: 'test.fake',
        actor: 'robot',
        attempt: 1,
        timestamp: '2026-09-10T00:00:01.000Z',
      };
      if (scenario === 'unassigned') {
        worker.send({ type: 'progress', runId: 'other', event });
      } else if (scenario === 'wrong-run') {
        worker.send({ type: 'progress', runId: 'other', event });
      } else {
        worker.send({ type: 'progress', runId: 'assigned', event });
        worker.send({ type: 'progress', runId: 'assigned', event });
      }

      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(fatalErrors.length, 1);
      assert.match(
        fatalErrors[0].message,
        scenario === 'unassigned'
          ? /progress received while idle/
          : scenario === 'wrong-run'
            ? /does not match assigned run/
            : /expected revision 2/,
      );
      await pool.close();
    });
  }
});

test('worker pool rejects progress while an ordered result is being persisted and does not reassign', async () => {
  const worker = new FakeWorker();
  const queue = createRunQueue();
  queue.enqueue(fakeQueuedRun('first'));
  queue.enqueue(fakeQueuedRun('second'));
  let resolveResult;
  const resultBlocked = new Promise((resolve) => {
    resolveResult = resolve;
  });
  const fatalErrors = [];
  const pool = createWorkerPool({
    size: 1,
    registry: createAdapterRegistry(),
    runQueue: queue,
    workspaceRoot: '/tmp',
    workerFactory: () => worker as unknown as Worker,
    onProgress: (runId, event) => {
      queue.applyProgress(runId, event);
    },
    onResult: async () => {
      await resultBlocked;
    },
    onRunFatal: async () => undefined,
    onFatal: (error) => fatalErrors.push(error),
  });
  pool.start();
  worker.send({ type: 'ready' });
  worker.send({
    type: 'result',
    runId: 'first',
    result: {
      status: 'passed',
      tree: createRunTree(caseDef({ type: 'Action', capability: 'test.fake', adapter: 'test', actor: 'robot' })),
      revision: 0,
    },
  });
  worker.send({
    type: 'progress',
    runId: 'first',
    event: {
      revision: 1,
      kind: 'started',
      path: '',
      nodeType: 'Action',
      capability: 'test.fake',
      actor: 'robot',
      attempt: 1,
      timestamp: '2026-09-10T00:00:01.000Z',
    },
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fatalErrors.length, 0);
  assert.equal(worker.posted.filter(({ type }) => type === 'run').length, 1);
  resolveResult();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fatalErrors.length, 1);
  assert.match(fatalErrors[0].message, /progress received while finalizing/);
  assert.equal(worker.posted.filter(({ type }) => type === 'run').length, 1);
  await pool.close();
});

test('worker pool reports fatal-run persistence failures once instead of hiding them', async () => {
  const worker = new FakeWorker();
  const queue = createRunQueue();
  queue.enqueue(fakeQueuedRun('assigned'));
  const fatalErrors = [];
  const pool = createWorkerPool({
    size: 1,
    registry: createAdapterRegistry(),
    runQueue: queue,
    workspaceRoot: '/tmp',
    workerFactory: () => worker as unknown as Worker,
    onProgress: () => undefined,
    onResult: async () => undefined,
    onRunFatal: async () => {
      throw new Error('disk unavailable');
    },
    onFatal: (error) => fatalErrors.push(error),
  });
  pool.start();
  worker.send({ type: 'ready' });
  worker.emit('error', new Error('worker crashed'));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(fatalErrors.length, 1);
  assert.match(fatalErrors[0].message, /worker crashed.*failed to persist fatal run.*disk unavailable/);
  assert.equal(queue.get('assigned').status, 'running');
  await pool.close();
});

test('worker pool consumes resolving and rejecting async progress callbacks before ordered fatal finalization', async (t) => {
  for (const outcome of ['resolve', 'reject']) {
    await t.test(outcome, async () => {
      const worker = new FakeWorker();
      const queue = createRunQueue();
      queue.enqueue(fakeQueuedRun('assigned'));
      const rejection = new Error('late progress rejection');
      const unhandled = [];
      const onUnhandled = (reason) => unhandled.push(reason);
      const fatalErrors = [];
      const order = [];
      let resultCalls = 0;
      process.on('unhandledRejection', onUnhandled);
      const pool = createWorkerPool({
        size: 1,
        registry: createAdapterRegistry(),
        runQueue: queue,
        workspaceRoot: '/tmp',
        workerFactory: () => worker as unknown as Worker,
        onProgress: () => {
          order.push('progress');
          return outcome === 'resolve' ? Promise.resolve() : Promise.reject(rejection);
        },
        onResult: async () => {
          resultCalls += 1;
        },
        onRunFatal: async () => {
          order.push('persist-fatal');
        },
        onFatal: (error) => {
          order.push('host-fatal');
          fatalErrors.push(error);
        },
      });
      try {
        pool.start();
        worker.send({ type: 'ready' });
        worker.send({
          type: 'progress',
          runId: 'assigned',
          event: {
            revision: 1,
            kind: 'started',
            path: '',
            nodeType: 'Action',
            capability: 'test.fake',
            actor: 'robot',
            attempt: 1,
            timestamp: '2026-09-10T00:00:01.000Z',
          },
        });
        await new Promise((resolve) => setImmediate(resolve));

        assert.equal(resultCalls, 0);
        assert.equal(fatalErrors.length, 1);
        assert.match(fatalErrors[0].message, /onProgress must be synchronous/);
        assert.deepEqual(order, ['progress', 'persist-fatal', 'host-fatal']);
        assert.deepEqual(unhandled, []);
      } finally {
        process.off('unhandledRejection', onUnhandled);
        await pool.close();
      }
    });
  }
});

test('result terminal claim wins fatal or error races while persistence is deferred', async (t) => {
  for (const race of ['fatal-message', 'worker-error']) {
    await t.test(race, async () => {
      const worker = new FakeWorker();
      const queue = createRunQueue();
      queue.enqueue(fakeQueuedRun('assigned'));
      let resolveResult;
      const resultBlocked = new Promise((resolve) => {
        resolveResult = resolve;
      });
      let resultCalls = 0;
      let runFatalCalls = 0;
      const fatalErrors = [];
      const pool = createWorkerPool({
        size: 1,
        registry: createAdapterRegistry(),
        runQueue: queue,
        workspaceRoot: '/tmp',
        workerFactory: () => worker as unknown as Worker,
        onProgress: () => undefined,
        onResult: async () => {
          resultCalls += 1;
          await resultBlocked;
        },
        onRunFatal: async () => {
          runFatalCalls += 1;
        },
        onFatal: (error) => fatalErrors.push(error),
      });
      pool.start();
      worker.send({ type: 'ready' });
      worker.send({
        type: 'result',
        runId: 'assigned',
        result: {
          status: 'passed',
          tree: createRunTree(caseDef({ type: 'Action', capability: 'test.fake', adapter: 'test', actor: 'robot' })),
          revision: 0,
        },
      });
      if (race === 'fatal-message') {
        worker.send({ type: 'fatal', runId: 'assigned', error: 'late fatal' });
      } else {
        worker.emit('error', new Error('late worker error'));
      }
      await new Promise((resolve) => setImmediate(resolve));

      assert.equal(resultCalls, 1);
      assert.equal(runFatalCalls, 0);
      assert.equal(fatalErrors.length, 0);
      resolveResult();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(resultCalls, 1);
      assert.equal(runFatalCalls, 0);
      assert.equal(fatalErrors.length, 1);
      assert.match(
        fatalErrors[0].message,
        race === 'fatal-message' ? /late fatal|fatal.*finalizing/ : /late worker error/,
      );
      await pool.close();
    });
  }
});

test('fatal terminal claim wins a later result and persists the run only once', async () => {
  const worker = new FakeWorker();
  const queue = createRunQueue();
  queue.enqueue(fakeQueuedRun('assigned'));
  let resolveFatalRun;
  const fatalRunBlocked = new Promise((resolve) => {
    resolveFatalRun = resolve;
  });
  let resultCalls = 0;
  let runFatalCalls = 0;
  const fatalErrors = [];
  const pool = createWorkerPool({
    size: 1,
    registry: createAdapterRegistry(),
    runQueue: queue,
    workspaceRoot: '/tmp',
    workerFactory: () => worker as unknown as Worker,
    onProgress: () => undefined,
    onResult: async () => {
      resultCalls += 1;
    },
    onRunFatal: async () => {
      runFatalCalls += 1;
      await fatalRunBlocked;
    },
    onFatal: (error) => fatalErrors.push(error),
  });
  pool.start();
  worker.send({ type: 'ready' });
  worker.send({ type: 'fatal', runId: 'assigned', error: 'claimed fatal' });
  worker.send({
    type: 'result',
    runId: 'assigned',
    result: {
      status: 'failed',
      tree: createRunTree(caseDef({ type: 'Action', capability: 'test.fake', adapter: 'test', actor: 'robot' })),
      revision: 0,
      error: 'claimed fatal',
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(runFatalCalls, 1);
  assert.equal(resultCalls, 0);
  assert.equal(fatalErrors.length, 0);
  resolveFatalRun();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runFatalCalls, 1);
  assert.equal(resultCalls, 0);
  assert.equal(fatalErrors.length, 1);
  assert.match(fatalErrors[0].message, /claimed fatal/);
  await pool.close();
});

test('worker pool lists stable slots, idle workers, and assigned runs', async () => {
  const created = [new FakeWorker(), new FakeWorker()];
  let next = 0;
  const queue = createRunQueue();
  queue.enqueue(fakeQueuedRun('run-a'));
  const pool = createWorkerPool({
    size: 2,
    registry: createAdapterRegistry(),
    runQueue: queue,
    workspaceRoot: '/tmp',
    workerFactory: () => created[next++] as unknown as Worker,
    onProgress: () => undefined,
    onResult: async () => undefined,
  });

  pool.start();
  assert.deepEqual(pool.list(), [
    { id: 'worker-1', state: 'starting', runId: null },
    { id: 'worker-2', state: 'starting', runId: null },
  ]);

  created[0]!.send({ type: 'ready' });
  created[1]!.send({ type: 'ready' });

  assert.deepEqual(pool.list(), [
    { id: 'worker-1', state: 'running', runId: 'run-a' },
    { id: 'worker-2', state: 'idle', runId: null },
  ]);
  await pool.close();
});
