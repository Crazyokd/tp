import assert from 'node:assert/strict';
import { test } from 'node:test';

import { httpCaseWriteSchema } from '@tp/contract';

import { TpApiError } from '../src/http.ts';
import { createCaseAndRun, waitForRun } from '../src/workflows.ts';

const definition = {
  main: 'Main',
  trees: {
    Main: {
      type: 'Sequence',
      children: [{ type: 'Action', adapter: 'demo', actor: 'robot', capability: 'go' }],
    },
  },
  sessions: [{ adapter: 'demo', actor: 'robot' }],
};
const write = httpCaseWriteSchema.parse({ name: 'n', description: 'n', definition });

const createdCase = {
  id: 'case-1',
  name: 'n',
  description: 'n',

  definition: write.definition,
  createdAt: '2026-09-16T00:00:00.000Z',
  updatedAt: '2026-09-16T00:00:00.000Z',
};

const queuedRun = {
  id: 'run-1',
  batchId: 'batch-1',
  caseId: 'case-1',
  status: 'queued',
  createdAt: '2026-09-16T00:00:00.000Z',
  startedAt: null,
  finishedAt: null,
  revision: 0,
  tree: {
    main: 'Main',
    trees: {
      Main: {
        type: 'Sequence',
        children: [
          {
            type: 'Action',
            adapter: 'demo',
            actor: 'robot',
            capability: 'go',
            status: 'pending',
            attempts: [],
          },
        ],
        status: 'pending',
        attempts: [],
      },
    },
  },
  artifacts: [],
};

const queuedBatch = {
  id: 'batch-1',
  name: 'n',
  description: '',
  trigger: { kind: 'mcp' },
  selection: { kind: 'cases' },
  createdAt: queuedRun.createdAt,
  startedAt: null,
  finishedAt: null,
  status: 'queued',
  counts: { queued: 1, running: 0, canceling: 0, passed: 0, failed: 0, canceled: 0 },
  runs: [queuedRun],
};

function unusedWatch() {
  return {
    watchRun() {
      throw new Error('watchRun must not run');
    },
  };
}

function hangClock() {
  return {
    now: () => 0,
    sleep: async (_ms: number, signal?: AbortSignal) => abortWhen(signal),
  };
}

function abortWhen(signal?: AbortSignal): Promise<void> {
  return new Promise((_resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'));
      return;
    }
    signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
}

test('createCaseAndRun creates the case then a single-case batch', async () => {
  const ids: string[] = [];
  const result = await createCaseAndRun(
    {
      invoke: async (id, input) => {
        ids.push(id);
        if (id === 'createCase') return createdCase;
        if (id === 'createBatch') {
          assert.deepEqual(input, { body: { caseIds: ['case-1'], trigger: { kind: 'mcp' } } });
          return queuedBatch;
        }
        throw new Error(id);
      },
      ...unusedWatch(),
    },
    write,
  );
  assert.deepEqual(ids, ['createCase', 'createBatch']);
  assert.deepEqual(result, { case: createdCase, batch: queuedBatch });
});

test('createCaseAndRun does not create a batch when createCase fails', async () => {
  const ids: string[] = [];
  await assert.rejects(
    () =>
      createCaseAndRun(
        {
          invoke: async (id) => {
            ids.push(id);
            throw new TpApiError('invalid', 'bad case');
          },
          ...unusedWatch(),
        },
        write,
      ),
    /bad case/,
  );
  assert.deepEqual(ids, ['createCase']);
});

test('createCaseAndRun keeps the case and mentions its id when createBatch fails', async () => {
  await assert.rejects(
    () =>
      createCaseAndRun(
        {
          invoke: async (id) => {
            if (id === 'createCase') return createdCase;
            throw new TpApiError('conflict', 'busy');
          },
          ...unusedWatch(),
        },
        write,
      ),
    (error: unknown) => {
      assert.ok(error instanceof TpApiError);
      assert.equal(error.code, 'conflict');
      assert.match(error.message, /createBatch/);
      assert.match(error.message, /case-1/);
      assert.match(error.message, /busy/);
      return true;
    },
  );
});

test('waitForRun returns the run when the first SSE frame is terminal', async () => {
  const passed = { ...queuedRun, status: 'passed', startedAt: queuedRun.createdAt, finishedAt: queuedRun.createdAt };
  const result = await waitForRun(
    {
      invoke: async () => {
        throw new Error('invoke must not run');
      },
      async *watchRun() {
        yield passed;
      },
    },
    { runId: 'run-1', timeoutMs: 1000 },
    hangClock(),
  );
  assert.deepEqual(result, passed);
});

test('waitForRun keeps watching until a terminal status', async () => {
  const passed = { ...queuedRun, status: 'canceled', startedAt: queuedRun.createdAt, finishedAt: queuedRun.createdAt };
  const result = await waitForRun(
    {
      invoke: async () => {
        throw new Error('invoke must not run');
      },
      async *watchRun() {
        yield queuedRun;
        yield passed;
      },
    },
    { runId: 'run-1', timeoutMs: 5000 },
    hangClock(),
  );
  assert.deepEqual(result, passed);
});

test('waitForRun fails on timeout with the last status', async () => {
  await assert.rejects(
    () =>
      waitForRun(
        {
          invoke: async () => {
            throw new Error('invoke must not run');
          },
          async *watchRun(_id, options) {
            yield queuedRun;
            await abortWhen(options?.signal);
          },
        },
        { runId: 'run-1', timeoutMs: 1 },
        {
          now: () => 0,
          sleep: async () => undefined,
        },
      ),
    /queued/,
  );
});

test('waitForRun fails immediately when the run is missing', async () => {
  await assert.rejects(
    () =>
      waitForRun(
        {
          invoke: async () => {
            throw new Error('invoke must not run');
          },
          watchRun() {
            throw new TpApiError('not_found', 'run missing');
          },
        },
        { runId: 'missing', timeoutMs: 1000 },
        hangClock(),
      ),
    /run missing/,
  );
});

test('waitForRun rejects missing keys before watchRun', async () => {
  const calls: string[] = [];
  await assert.rejects(() =>
    waitForRun(
      {
        invoke: async () => {
          throw new Error('unused');
        },
        async *watchRun() {
          calls.push('watchRun');
          yield;
        },
      },
      {},
      { now: () => 0, sleep: async () => undefined },
    ),
  );
  assert.deepEqual(calls, []);
});

test('waitForRun rejects timeoutMs 0 before watchRun', async () => {
  const calls: string[] = [];
  await assert.rejects(() =>
    waitForRun(
      {
        invoke: async () => {
          throw new Error('unused');
        },
        async *watchRun() {
          calls.push('watchRun');
          yield;
        },
      },
      { runId: 'run-1', timeoutMs: 0 },
      { now: () => 0, sleep: async () => undefined },
    ),
  );
  assert.deepEqual(calls, []);
});
