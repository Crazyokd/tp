import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CatalogCapability } from '@tp/contract/adapter';

import { applyRunProgressEvent, createRunTree, findRunNode, type CaseDefinition, type TreeNode } from '@tp/contract';
import { executeTree as executeDocument, WorkerFatalError } from '../src/bt.ts';
import { caseDef, leafCapabilities, testLeafAdapter } from './case-def.ts';

function executeTree(definition: TreeNode | CaseDefinition, options?: Parameters<typeof executeDocument>[1]) {
  return executeDocument(caseDef(definition), {
    adapter: testLeafAdapter,
    capabilities: leafCapabilities(definition),
    ...options,
  });
}

const writer: CatalogCapability = {
  adapter: 'demo',
  key: 'demo.write',
  kind: 'Action',
  label: 'Write',
  ports: [{ name: 'name', direction: 'out', schema: { type: 'string' } }],
};

const reader: CatalogCapability = {
  adapter: 'demo',
  key: 'demo.read',
  kind: 'Action',
  label: 'Read',
  ports: [{ name: 'name', direction: 'in', schema: { type: 'string' } }],
};

test('later leaf reads earlier leaf through platform-assembled input', async () => {
  const seen: unknown[] = [];
  const result = await executeTree(
    {
      type: 'Sequence',
      children: [
        {
          type: 'Action',
          adapter: 'demo',
          actor: 'robot',
          capability: 'demo.write',
          ports: { name: { key: 'demo.name' } },
        },
        {
          type: 'Action',
          adapter: 'demo',
          actor: 'robot',
          capability: 'demo.read',
          ports: { name: { key: 'demo.name' } },
        },
      ],
    },
    {
      capabilities: [writer, reader],
      adapter: async (node, context) => {
        if (node.capability === 'demo.write') {
          return { status: 'SUCCESS', output: { name: 'atlas' } };
        }
        seen.push(context.input);
        return { status: 'SUCCESS' };
      },
    },
  );

  assert.equal(result.status, 'passed');
  assert.deepEqual(seen, [{ name: 'atlas' }]);
});

test('failed leaf commits output writes on the same tick', async () => {
  const result = await executeTree(
    {
      type: 'ParallelAll',
      children: [
        {
          type: 'Action',
          adapter: 'demo',
          actor: 'robot',
          capability: 'demo.write',
          ports: { name: { key: 'demo.name' } },
        },
        {
          type: 'Action',
          adapter: 'demo',
          actor: 'robot',
          capability: 'demo.read',
          ports: { name: { key: 'demo.name' } },
        },
      ],
    },
    {
      capabilities: [writer, reader],
      adapter: async (node) => {
        if (node.capability === 'demo.write') {
          return { status: 'FAILURE', output: { name: 'ghost' } };
        }
        return { status: 'SUCCESS' };
      },
    },
  );

  assert.equal(result.status, 'failed');
});

test('FAILURE output.error is a leaf failure when the capability declares the port', async () => {
  const definition = { type: 'Action' as const, adapter: 'demo', actor: 'robot', capability: 'demo.write' };
  let progress = { revision: 0, tree: createRunTree(caseDef(definition)) };
  const result = await executeTree(definition, {
    capabilities: [
      {
        ...writer,
        ports: [...writer.ports, { name: 'error', direction: 'out', schema: { type: 'string' }, required: false }],
      },
    ],
    adapter: async () => ({ status: 'FAILURE', output: { error: 'not ready' } }),
    onProgress: (event) => {
      progress = applyRunProgressEvent(progress, event);
    },
  });

  assert.equal(result.status, 'failed');
  assert.equal('error' in result, false);
  assert.equal(findRunNode(progress.tree, '').attempts.at(-1)?.output?.error, 'not ready');
  assert.equal(findRunNode(progress.tree, '').attempts.at(-1)?.error, 'not ready');
});

test('FAILURE output.error is a run accident when the capability does not declare the port', async () => {
  await assert.rejects(
    () =>
      executeTree(
        { type: 'Action', adapter: 'demo', actor: 'robot', capability: 'demo.write' },
        {
          capabilities: [writer],
          adapter: async () => ({ status: 'FAILURE', output: { error: 'not ready' } }),
        },
      ),
    (error: unknown) => error instanceof WorkerFatalError && /error/.test(error.message),
  );
});

test('blackboard value that does not match the input schema fails the leaf without calling tick', async () => {
  const calls: string[] = [];
  const result = await executeTree(
    {
      type: 'Sequence',
      children: [
        {
          type: 'Action',
          adapter: 'demo',
          actor: 'robot',
          capability: 'demo.write',
          ports: { name: { key: 'demo.name' } },
        },
        {
          type: 'Action',
          adapter: 'demo',
          actor: 'robot',
          capability: 'demo.read',
          ports: { name: { key: 'demo.name' } },
        },
      ],
    },
    {
      capabilities: [{ ...writer, ports: [{ name: 'name', direction: 'out', schema: { type: 'number' } }] }, reader],
      adapter: async (node) => {
        calls.push(node.capability);
        if (node.capability === 'demo.write') return { status: 'SUCCESS', output: { name: 1 } };
        return { status: 'SUCCESS' };
      },
    },
  );

  assert.equal(result.status, 'failed');
  assert.deepEqual(calls, ['demo.write']);
});

test('output that does not match the declared schema is a run accident', async () => {
  await assert.rejects(
    () =>
      executeTree(
        {
          type: 'Action',
          adapter: 'demo',
          actor: 'robot',
          capability: 'demo.write',
          ports: { name: { key: 'demo.name' } },
        },
        {
          capabilities: [writer],
          adapter: async () => ({ status: 'SUCCESS', output: { name: 1 } }),
        },
      ),
    (error: unknown) => error instanceof WorkerFatalError && /does not match schema/.test(error.message),
  );
});

test('missing required blackboard key fails the leaf without calling tick', async () => {
  const calls: string[] = [];
  const result = await executeTree(
    {
      type: 'Action',
      adapter: 'demo',
      actor: 'robot',
      capability: 'demo.read',
      ports: { name: { key: 'demo.name' } },
    },
    {
      capabilities: [reader],
      adapter: async (node) => {
        calls.push(node.capability);
        return { status: 'SUCCESS' };
      },
    },
  );

  assert.equal(result.status, 'failed');
  assert.deepEqual(calls, []);
});
