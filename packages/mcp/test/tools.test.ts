import assert from 'node:assert/strict';
import { test } from 'node:test';

import { operations } from '@tp/contract';
import { z } from 'zod';

import { createServerTools } from '../src/index.ts';
import { CONTRACT_TOOL_IDS, createTools, invokeFromToolInput } from '../src/tools.ts';

test('contract tool ids are exactly the allowlist and exist on the contract', () => {
  assert.deepEqual(
    [...CONTRACT_TOOL_IDS],
    [
      'listAdapters',
      'getAdapter',
      'listCases',
      'createCase',
      'getCase',
      'updateCase',
      'deleteCase',
      'listGroups',
      'createGroup',
      'getGroup',
      'updateGroup',
      'deleteGroup',
      'listBatches',
      'getBatch',
      'createBatch',
      'cancelBatch',
      'listRuns',
      'cancelRun',
    ],
  );
  const ids = new Set(operations.map((item) => item.id));
  for (const id of CONTRACT_TOOL_IDS) assert.equal(ids.has(id), true, id);
  assert.equal(CONTRACT_TOOL_IDS.includes('getRunArtifact'), false);
  const forbidden = operations.filter(
    (item) => item.tag === 'Workers' || item.tag === 'Ops' || item.id === 'getRunArtifact',
  );
  for (const item of forbidden) {
    assert.equal((CONTRACT_TOOL_IDS as readonly string[]).includes(item.id), false, item.id);
  }
});

test('createTools names are allowlist plus the two workflow tools', () => {
  const tools = createTools({
    invoke: async () => {
      throw new Error('unused');
    },
    watchRun() {
      throw new Error('unused');
    },
  });
  assert.deepEqual(
    tools.map((tool) => tool.name),
    [...CONTRACT_TOOL_IDS, 'createCaseAndRun', 'waitForRun'],
  );
});

test('createTools descriptions tell the operator when and how to call each tool', () => {
  const tools = createTools({
    invoke: async () => {
      throw new Error('unused');
    },
    watchRun() {
      throw new Error('unused');
    },
  });
  const byName = new Map(tools.map((tool) => [tool.name, tool.description]));
  for (const tool of tools) {
    assert.equal(tool.description.includes('\n'), false, tool.name);
    assert.ok(tool.description.length > 40, tool.name);
  }
  assert.match(byName.get('listAdapters')!, /catalog|capability/i);
  assert.match(byName.get('getAdapter')!, /session ports|capability ports/i);
  assert.match(byName.get('listCases')!, /before createBatch/i);
  assert.match(byName.get('createCase')!, /sessions/i);
  assert.match(byName.get('getCase')!, /sessions/i);
  assert.match(byName.get('updateCase')!, /live run/i);
  assert.match(byName.get('deleteCase')!, /live run/i);
  assert.match(byName.get('listRuns')!, /status/i);
  assert.match(byName.get('listBatches')!, /status/i);
  assert.match(byName.get('getBatch')!, /runs/i);
  assert.match(byName.get('createBatch')!, /caseIds.*groupId/i);
  assert.match(byName.get('createBatch')!, /name.*description/i);
  assert.match(byName.get('createBatch')!, /declared.*provenance/i);
  assert.match(byName.get('createCaseAndRun')!, /mcp/i);
  assert.match(byName.get('cancelBatch')!, /halt/i);
  assert.match(byName.get('cancelRun')!, /halt/i);
  assert.match(byName.get('createCaseAndRun')!, /does not roll back/i);
  assert.match(byName.get('waitForRun')!, /timeoutMs/i);
  assert.match(byName.get('waitForRun')!, /SSE/i);
});

test('invokeFromToolInput splits path id from the body for updateCase', async () => {
  const calls: Array<{ id: string; input: unknown }> = [];
  await invokeFromToolInput(
    {
      invoke: async (id, input) => {
        calls.push({ id, input });
        return { ok: true };
      },
      watchRun() {
        throw new Error('unused');
      },
    },
    'updateCase',
    {
      id: 'case-1',
      name: 'n',
      description: 'n',

      definition: {
        main: 'Main',
        trees: {
          Main: {
            type: 'Sequence',
            children: [{ type: 'Action', adapter: 'demo', actor: 'robot', capability: 'go' }],
          },
        },
        sessions: [{ adapter: 'demo', actor: 'robot' }],
      },
    },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.id, 'updateCase');
  assert.deepEqual(calls[0]!.input, {
    params: { id: 'case-1' },
    query: {},
    body: {
      name: 'n',
      description: 'n',

      definition: {
        main: 'Main',
        trees: {
          Main: {
            type: 'Sequence',
            children: [{ type: 'Action', adapter: 'demo', actor: 'robot', capability: 'go' }],
          },
        },
        sessions: [{ adapter: 'demo', actor: 'robot' }],
      },
    },
  });
});

test('createServerTools uses resolveBaseUrl before creating tools', () => {
  assert.throws(() => createServerTools({ TP_BASE_URL: 'ftp://x' }), /TP_BASE_URL/);
});

test('Batch tools forward contract selectors, ids and pagination', async () => {
  const calls: Array<{ id: string; input: unknown }> = [];
  const result = {
    id: 'batch-1',
    name: 'Batch',
    description: '',
    trigger: { kind: 'mcp' },
    selection: { kind: 'cases' },
  };
  const tools = createTools({
    invoke: async (id, input) => {
      calls.push({ id, input });
      return result;
    },
    watchRun() {
      throw new Error('unused');
    },
  });
  for (const [name, input, expected] of [
    [
      'createBatch',
      { caseIds: ['case-1'], blackboard: { key: 'value' }, trigger: { kind: 'mcp' } },
      { params: {}, query: {}, body: { caseIds: ['case-1'], blackboard: { key: 'value' }, trigger: { kind: 'mcp' } } },
    ],
    [
      'createBatch',
      {
        groupId: 'group-1',
        name: 'CI suite',
        description: 'Nightly',
        trigger: { kind: 'ci', pipelineUrl: 'https://ci.example/pipelines/1' },
      },
      {
        params: {},
        query: {},
        body: {
          groupId: 'group-1',
          name: 'CI suite',
          description: 'Nightly',
          trigger: { kind: 'ci', pipelineUrl: 'https://ci.example/pipelines/1' },
        },
      },
    ],
    ['listBatches', { limit: 10, offset: 0 }, { params: {}, query: { limit: 10, offset: 0 }, body: undefined }],
    ['getBatch', { id: 'batch-1' }, { params: { id: 'batch-1' }, query: {}, body: undefined }],
    ['cancelBatch', { id: 'batch-1' }, { params: { id: 'batch-1' }, query: {}, body: undefined }],
  ] as const) {
    const tool = tools.find((tool) => tool.name === name)!;
    assert.deepEqual(await tool.execute(input), result);
    assert.deepEqual(calls.at(-1), { id: name, input: expected });
  }
});

test('createBatch rejects invalid or legacy selectors before invoking the client', async () => {
  const tools = createTools({
    invoke: async () => {
      throw new Error('client must not run');
    },
    watchRun() {
      throw new Error('unused');
    },
  });
  const tool = tools.find((tool) => tool.name === 'createBatch')!;
  for (const input of [
    {},
    { caseIds: [] },
    { caseIds: ['c', 'c'] },
    { caseIds: ['c'], groupId: 'g' },
    { caseId: 'c' },
    { group: 'g' },
    { groupId: 'g', extra: true },
  ]) {
    const request = { ...input, trigger: { kind: 'mcp' } };
    assert.equal(tool.inputSchema.safeParse(request).success, false, JSON.stringify(request));
    await assert.rejects(
      () => tool.execute(request),
      (error: Error) => error.message !== 'client must not run',
    );
  }
});

test('createBatch requires declared provenance and rejects invalid metadata before HTTP', async () => {
  const tools = createTools({
    invoke: async () => {
      throw new Error('client must not run');
    },
    watchRun() {
      throw new Error('unused');
    },
  });
  const tool = tools.find((tool) => tool.name === 'createBatch')!;
  const selector = { caseIds: ['case-1'] };
  for (const metadata of [
    {},
    { trigger: { kind: 'unknown' } },
    { trigger: { kind: 'mcp', extra: true } },
    { trigger: { kind: 'mcp', pipelineUrl: 'https://ci.example/1' } },
    { trigger: { kind: 'web', pipelineUrl: 'https://ci.example/1' } },
    { trigger: { kind: 'ci', pipelineUrl: 'javascript:alert(1)' } },
    { trigger: { kind: 'ci', pipelineUrl: 'file:///tmp/pipeline' } },
    { trigger: { kind: 'mcp' }, name: '  ' },
    { trigger: { kind: 'mcp' }, description: null },
    { trigger: { kind: 'mcp' }, source: 'mcp' },
    { trigger: { kind: 'mcp' }, selection: { kind: 'cases' } },
  ]) {
    const input = { ...selector, ...metadata };
    assert.equal(tool.inputSchema.safeParse(input).success, false, JSON.stringify(input));
    await assert.rejects(
      () => tool.execute(input),
      (error: Error) => error.message !== 'client must not run',
    );
  }
});

test('createBatch advertises metadata from the contract without defaults or caller selection', () => {
  const tool = createTools({
    invoke: async () => {
      throw new Error('unused');
    },
    watchRun() {
      throw new Error('unused');
    },
  }).find((tool) => tool.name === 'createBatch')!;
  const schema = z.toJSONSchema(tool.inputSchema);
  assert.ok(schema.required?.includes('trigger'));
  assert.ok(!schema.required?.includes('name'));
  assert.ok(!schema.required?.includes('description'));
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties?.selection, undefined);
  for (const trigger of [
    { kind: 'mcp' },
    { kind: 'web' },
    { kind: 'ci' },
    { kind: 'ci', pipelineUrl: 'http://ci.example/1' },
  ]) {
    assert.deepEqual(tool.inputSchema.parse({ caseIds: ['c'], trigger }), { caseIds: ['c'], trigger });
  }
});
