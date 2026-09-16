import assert from 'node:assert/strict';
import { test } from 'node:test';

import { operations } from '@tp/contract';

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
      'listRuns',
      'createRun',
      'getRun',
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
  });
  assert.deepEqual(
    tools.map((tool) => tool.name),
    [...CONTRACT_TOOL_IDS, 'createCaseAndRun', 'waitForRun'],
  );
});

test('invokeFromToolInput splits path id from the body for updateCase', async () => {
  const calls: Array<{ id: string; input: unknown }> = [];
  await invokeFromToolInput(
    {
      invoke: async (id, input) => {
        calls.push({ id, input });
        return { ok: true };
      },
    },
    'updateCase',
    {
      id: 'case-1',
      name: 'n',
      definition: {
        main: 'Main',
        trees: {
          Main: {
            type: 'Sequence',
            children: [{ type: 'Action', adapter: 'demo', actor: 'robot', capability: 'go' }],
          },
        },
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
      definition: {
        main: 'Main',
        trees: {
          Main: {
            type: 'Sequence',
            children: [{ type: 'Action', adapter: 'demo', actor: 'robot', capability: 'go' }],
          },
        },
      },
    },
  });
});

test('createServerTools uses resolveBaseUrl before creating tools', () => {
  assert.throws(() => createServerTools({ TP_BASE_URL: 'ftp://x' }), /TP_BASE_URL/);
});
