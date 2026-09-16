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

test('posts createRun body and returns 201 JSON', async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const run = {
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
  const client = createTpClient({
    baseUrl: 'http://127.0.0.1:3000',
    fetch: async (input, init) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return jsonResponse(201, run);
    },
  });

  assert.deepEqual(await client.invoke('createRun', { body: { caseId: 'case-1' } }), run);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { url: 'http://127.0.0.1:3000/api/runs', body: { caseId: 'case-1' } });
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
