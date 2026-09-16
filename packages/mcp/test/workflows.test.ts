import assert from 'node:assert/strict';
import { test } from 'node:test';

import { httpCaseWriteSchema } from '@tp/contract';

import { TpApiError } from '../src/http.ts';
import { createCaseAndRun, waitForRun, WAIT_POLL_INTERVAL_MS } from '../src/workflows.ts';

const definition = {
  main: 'Main',
  trees: {
    Main: {
      type: 'Sequence',
      children: [{ type: 'Action', adapter: 'demo', actor: 'robot', capability: 'go' }],
    },
  },
};
const write = httpCaseWriteSchema.parse({ name: 'n', definition });

const createdCase = {
  id: 'case-1',
  name: 'n',
  definition: write.definition,
  createdAt: '2026-09-16T00:00:00.000Z',
  updatedAt: '2026-09-16T00:00:00.000Z',
};

const queuedRun = {
  id: 'run-1',
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

test('createCaseAndRun creates the case then the run', async () => {
  const ids: string[] = [];
  const result = await createCaseAndRun(
    {
      invoke: async (id, input) => {
        ids.push(id);
        if (id === 'createCase') return createdCase;
        if (id === 'createRun') {
          assert.deepEqual(input, { body: { caseId: 'case-1' } });
          return queuedRun;
        }
        throw new Error(id);
      },
    },
    write,
  );
  assert.deepEqual(ids, ['createCase', 'createRun']);
  assert.deepEqual(result, { case: createdCase, run: queuedRun });
});

test('createCaseAndRun does not create a run when createCase fails', async () => {
  const ids: string[] = [];
  await assert.rejects(
    () =>
      createCaseAndRun(
        {
          invoke: async (id) => {
            ids.push(id);
            throw new TpApiError('invalid', 'bad case');
          },
        },
        write,
      ),
    /bad case/,
  );
  assert.deepEqual(ids, ['createCase']);
});

test('createCaseAndRun keeps the case and mentions its id when createRun fails', async () => {
  await assert.rejects(
    () =>
      createCaseAndRun(
        {
          invoke: async (id) => {
            if (id === 'createCase') return createdCase;
            throw new TpApiError('conflict', 'busy');
          },
        },
        write,
      ),
    (error: unknown) => {
      assert.ok(error instanceof TpApiError);
      assert.equal(error.code, 'conflict');
      assert.match(error.message, /case-1/);
      assert.match(error.message, /busy/);
      return true;
    },
  );
});

test('waitForRun returns the run when it is already terminal', async () => {
  const passed = { ...queuedRun, status: 'passed', startedAt: queuedRun.createdAt, finishedAt: queuedRun.createdAt };
  const result = await waitForRun(
    {
      invoke: async () => passed,
    },
    { runId: 'run-1', timeoutMs: 1000 },
    {
      now: () => 0,
      sleep: async () => {
        throw new Error('sleep must not run');
      },
    },
  );
  assert.equal(result, passed);
});

test('waitForRun polls until a terminal status', async () => {
  const passed = { ...queuedRun, status: 'canceled', startedAt: queuedRun.createdAt, finishedAt: queuedRun.createdAt };
  let tick = 0;
  const sleeps: number[] = [];
  const result = await waitForRun(
    {
      invoke: async () => {
        tick += 1;
        return tick === 1 ? queuedRun : passed;
      },
    },
    { runId: 'run-1', timeoutMs: 5000 },
    {
      now: () => 0,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    },
  );
  assert.equal(result, passed);
  assert.deepEqual(sleeps, [WAIT_POLL_INTERVAL_MS]);
});

test('waitForRun fails on timeout with the last status', async () => {
  await assert.rejects(
    () =>
      waitForRun(
        { invoke: async () => queuedRun },
        { runId: 'run-1', timeoutMs: 1 },
        {
          now: (() => {
            let n = 0;
            return () => {
              n += 1;
              return n === 1 ? 0 : 2;
            };
          })(),
          sleep: async () => {
            throw new Error('sleep must not run after deadline');
          },
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
            throw new TpApiError('not_found', 'run missing');
          },
        },
        { runId: 'missing', timeoutMs: 1000 },
        { now: () => 0, sleep: async () => undefined },
      ),
    /run missing/,
  );
});

test('waitForRun rejects missing keys before getRun', async () => {
  const ids: string[] = [];
  await assert.rejects(() =>
    waitForRun(
      {
        invoke: async (id) => {
          ids.push(id);
          throw new Error('unused');
        },
      },
      {},
      { now: () => 0, sleep: async () => undefined },
    ),
  );
  assert.deepEqual(ids, []);
});

test('waitForRun rejects timeoutMs 0 before getRun', async () => {
  const ids: string[] = [];
  await assert.rejects(() =>
    waitForRun(
      {
        invoke: async (id) => {
          ids.push(id);
          throw new Error('unused');
        },
      },
      { runId: 'run-1', timeoutMs: 0 },
      { now: () => 0, sleep: async () => undefined },
    ),
  );
  assert.deepEqual(ids, []);
});
