import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createTpClient, TpApiError } from '../src/http.ts';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('invokes listAdapters from the contract path and parses the page', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const client = createTpClient({
    baseUrl: 'http://127.0.0.1:3000',
    fetch: async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      return jsonResponse(200, { items: [], total: 0 });
    },
  });

  const page = await client.invoke('listAdapters', { query: { limit: 10, offset: 0 } });
  assert.deepEqual(page, { items: [], total: 0 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, 'http://127.0.0.1:3000/api/adapters?limit=10&offset=0');
  assert.equal(calls[0]!.init.method, 'GET');
});

test('fills path params for getAdapter', async () => {
  const calls: string[] = [];
  const client = createTpClient({
    baseUrl: 'http://127.0.0.1:3000',
    fetch: async (input) => {
      calls.push(String(input));
      return jsonResponse(200, { id: 'demo', capabilities: [] });
    },
  });

  const adapter = await client.invoke('getAdapter', { params: { id: 'demo' } });
  assert.deepEqual(adapter, { id: 'demo', capabilities: [] });
  assert.equal(calls[0], 'http://127.0.0.1:3000/api/adapters/demo');
});

test('posts createBatch body and returns the native Batch', async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const run = {
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
  const batch = {
    id: 'batch-1',
    name: 'Single Case',
    description: 'MCP verification',
    trigger: { kind: 'mcp' },
    selection: { kind: 'cases' },
    createdAt: run.createdAt,
    startedAt: null,
    finishedAt: null,
    status: 'queued',
    counts: { queued: 1, running: 0, canceling: 0, passed: 0, failed: 0, canceled: 0 },
    runs: [run],
  };
  const client = createTpClient({
    baseUrl: 'http://127.0.0.1:3000',
    fetch: async (input, init) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return jsonResponse(201, batch);
    },
  });

  assert.deepEqual(
    await client.invoke('createBatch', { body: { caseIds: ['case-1'], trigger: { kind: 'mcp' } } }),
    batch,
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    url: 'http://127.0.0.1:3000/api/batches',
    body: { caseIds: ['case-1'], trigger: { kind: 'mcp' } },
  });
  for (const key of ['name', 'description', 'trigger', 'selection'] as const) {
    const incomplete = { ...batch };
    delete (incomplete as Partial<typeof batch>)[key];
    const invalidClient = createTpClient({
      baseUrl: 'http://127.0.0.1:3000',
      fetch: async () => jsonResponse(200, incomplete),
    });
    await assert.rejects(() => invalidClient.invoke('getBatch', { params: { id: batch.id } }), new RegExp(key));
  }
});

test('throws TpApiError with contract code and message', async () => {
  const client = createTpClient({
    baseUrl: 'http://127.0.0.1:3000',
    fetch: async () => jsonResponse(404, { code: 'not_found', message: 'case missing' }),
  });

  await assert.rejects(
    () => client.invoke('getCase', { params: { id: 'missing' } }),
    (error: unknown) => {
      assert.ok(error instanceof TpApiError);
      assert.equal(error.code, 'not_found');
      assert.equal(error.message, 'case missing');
      return true;
    },
  );
});

test('fails when the response JSON does not match the contract', async () => {
  const client = createTpClient({
    baseUrl: 'http://127.0.0.1:3000',
    fetch: async () => jsonResponse(200, { id: 'demo' }),
  });

  await assert.rejects(() => client.invoke('getAdapter', { params: { id: 'demo' } }), /getAdapter|capabilities/);
});

test('fails the invoke when the server is unreachable', async () => {
  const client = createTpClient({
    baseUrl: 'http://127.0.0.1:3000',
    fetch: async () => {
      throw new TypeError('fetch failed');
    },
  });

  await assert.rejects(() => client.invoke('listAdapters', {}), /fetch failed/);
});

test('watchRun reads SSE run frames from the contract path', async () => {
  const queued = {
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
          type: 'Action',
          adapter: 'test',
          actor: 'robot',
          capability: 'test.pass',
          status: 'pending',
          attempts: [],
        },
      },
    },
    artifacts: [],
  };
  const calls: Array<{ url: string; headers: HeadersInit | undefined }> = [];
  const client = createTpClient({
    baseUrl: 'http://127.0.0.1:3000',
    fetch: async (input, init) => {
      calls.push({ url: String(input), headers: init?.headers });
      return new Response(`id: 0\nevent: run\ndata: ${JSON.stringify(queued)}\n\n`, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    },
  });

  const frames: unknown[] = [];
  for await (const frame of client.watchRun('run-1')) frames.push(frame);
  assert.deepEqual(frames, [queued]);
  assert.equal(calls[0]!.url, 'http://127.0.0.1:3000/api/runs/run-1/events');
});

test('watchRun throws TpApiError when the stream cannot open', async () => {
  const client = createTpClient({
    baseUrl: 'http://127.0.0.1:3000',
    fetch: async () => jsonResponse(404, { code: 'not_found', message: 'run missing' }),
  });
  await assert.rejects(async () => {
    for await (const _frame of client.watchRun('missing')) {
      throw new Error('must not yield');
    }
  }, /run missing/);
});

test('rejects unknown operation ids', async () => {
  const client = createTpClient({
    baseUrl: 'http://127.0.0.1:3000',
    fetch: async () => {
      throw new Error('fetch must not run');
    },
  });

  await assert.rejects(() => client.invoke('notAnOperation', {}), /unknown HTTP operation notAnOperation/);
});

test('returns undefined for deleteCase 204 empty body', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const client = createTpClient({
    baseUrl: 'http://127.0.0.1:3000',
    fetch: async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      return new Response(null, { status: 204 });
    },
  });

  const result = await client.invoke('deleteCase', { params: { id: 'c1' } });
  assert.equal(result, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, 'http://127.0.0.1:3000/api/cases/c1');
  assert.equal(calls[0]!.init.method, 'DELETE');
});
