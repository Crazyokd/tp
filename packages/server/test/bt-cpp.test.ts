import assert from 'node:assert/strict';
import { test } from 'node:test';

import { executeTree as executeDocument, WorkerFatalError } from '../src/bt.ts';
import type { CaseDefinition, NodeStatusResult, LeafNode, TreeNode } from '@tp/contract';
import { caseDef, leafCapabilities, testLeafAdapter } from './case-def.ts';

function executeTree(definition: TreeNode | CaseDefinition, options?: Parameters<typeof executeDocument>[1]) {
  return executeDocument(caseDef(definition), {
    adapter: testLeafAdapter,
    capabilities: leafCapabilities(definition),
    ...options,
  });
}

test('Sequence does not rerun a successful child on later ticks', async () => {
  const calls: string[] = [];
  const result = await executeTree(
    {
      type: 'Sequence',
      children: [
        { type: 'Action', capability: 'first', adapter: 'test', actor: 'robot' },
        { type: 'Action', capability: 'slow', adapter: 'test', actor: 'robot' },
      ],
    },
    {
      adapter: async (node) => {
        calls.push(node.capability);
        if (node.capability === 'slow') await new Promise((resolve) => setImmediate(resolve));
        return { status: 'SUCCESS' };
      },
    },
  );

  assert.equal(result.status, 'passed');
  assert.deepEqual(calls, ['first', 'slow']);
});

test('ReactiveSequence reticks earlier children and halts a later running sibling on failure', async () => {
  const calls: string[] = [];
  let guard = 0;
  const result = await executeTree(
    {
      type: 'ReactiveSequence',
      children: [
        { type: 'Condition', capability: 'guard', adapter: 'test', actor: 'robot' },
        { type: 'Action', capability: 'work', adapter: 'test', actor: 'robot' },
      ],
    },
    {
      adapter: async (node) => {
        calls.push(node.capability);
        if (node.capability === 'guard') {
          guard += 1;
          return { status: guard >= 3 ? 'FAILURE' : 'SUCCESS' };
        }
        await new Promise(() => undefined);
        return { status: 'FAILURE' };
      },
      haltLeaf: async () => undefined,
    },
  );

  assert.equal(result.status, 'failed');
  assert.ok(calls.filter((capability) => capability === 'guard').length >= 3);
  assert.equal(calls.filter((capability) => capability === 'work').length, 1);
});

test('Fallback stops after the first success and ReactiveFallback reticks earlier children', async () => {
  const fallbackCalls: string[] = [];
  const fallback = await executeTree(
    {
      type: 'Fallback',
      children: [
        { type: 'Action', capability: 'fail', adapter: 'test', actor: 'robot' },
        { type: 'Action', capability: 'ok', adapter: 'test', actor: 'robot' },
        { type: 'Action', capability: 'never', adapter: 'test', actor: 'robot' },
      ],
    },
    {
      adapter: async (node) => {
        fallbackCalls.push(node.capability);
        return { status: node.capability === 'ok' ? 'SUCCESS' : 'FAILURE' };
      },
    },
  );
  assert.equal(fallback.status, 'passed');
  assert.deepEqual(fallbackCalls, ['fail', 'ok']);

  const reactiveCalls: string[] = [];
  let gate = 0;
  const reactive = await executeTree(
    {
      type: 'ReactiveFallback',
      children: [
        { type: 'Condition', capability: 'gate', adapter: 'test', actor: 'robot' },
        { type: 'Action', capability: 'backup', adapter: 'test', actor: 'robot' },
      ],
    },
    {
      adapter: async (node) => {
        reactiveCalls.push(node.capability);
        if (node.capability === 'gate') {
          gate += 1;
          return { status: gate >= 2 ? 'SUCCESS' : 'FAILURE' };
        }
        await new Promise(() => undefined);
        return { status: 'FAILURE' };
      },
    },
  );
  assert.equal(reactive.status, 'passed');
  assert.ok(reactiveCalls.filter((capability) => capability === 'gate').length >= 2);
});

test('Parallel halts remaining children when failure_count is reached', async () => {
  const halted: string[] = [];
  const result = await executeTree(
    {
      type: 'Parallel',
      failure_count: 1,
      children: [
        { type: 'Action', capability: 'fail', adapter: 'test', actor: 'robot' },
        { type: 'Action', capability: 'slow', adapter: 'test', actor: 'robot' },
      ],
    },
    {
      adapter: async (node) => {
        if (node.capability === 'fail') return { status: 'FAILURE' };
        return { status: 'RUNNING' };
      },
      haltLeaf: async (node) => {
        halted.push(node.capability);
      },
    },
  );

  assert.equal(result.status, 'failed');
  assert.deepEqual(halted, ['slow']);
});

test('Parallel failure_count=-1 does not halt a sibling after one failure', async () => {
  const halted: string[] = [];
  const calls: string[] = [];
  let slowTicks = 0;
  const result = await executeTree(
    {
      type: 'Parallel',
      failure_count: -1,
      children: [
        { type: 'Action', capability: 'fail', adapter: 'test', actor: 'robot' },
        { type: 'Action', capability: 'slow', adapter: 'test', actor: 'robot' },
      ],
    },
    {
      adapter: async (node) => {
        calls.push(node.capability);
        if (node.capability === 'fail') return { status: 'FAILURE' };
        slowTicks += 1;
        if (slowTicks === 1) return { status: 'RUNNING' };
        return { status: 'SUCCESS' };
      },
      haltLeaf: async (node) => {
        halted.push(node.capability);
      },
    },
  );

  assert.equal(result.status, 'failed');
  assert.ok(calls.includes('slow'));
  assert.equal(slowTicks, 2);
  assert.deepEqual(halted, []);
});

test('ParallelAll does not halt siblings after an ordinary failure', async () => {
  const calls: string[] = [];
  const result = await executeTree(
    {
      type: 'ParallelAll',
      children: [
        { type: 'Action', capability: 'fail', adapter: 'test', actor: 'robot' },
        { type: 'Action', capability: 'ok', adapter: 'test', actor: 'robot' },
      ],
    },
    {
      adapter: async (node) => {
        calls.push(node.capability);
        return { status: node.capability === 'fail' ? 'FAILURE' : 'SUCCESS' };
      },
    },
  );

  assert.equal(result.status, 'failed');
  assert.deepEqual(new Set(calls), new Set(['fail', 'ok']));
});

test('ParallelAll max_failures=-1 still runs all children', async () => {
  const calls: string[] = [];
  const result = await executeTree(
    {
      type: 'ParallelAll',
      max_failures: -1,
      children: [
        { type: 'Action', capability: 'fail', adapter: 'test', actor: 'robot' },
        { type: 'Action', capability: 'ok', adapter: 'test', actor: 'robot' },
      ],
    },
    {
      adapter: async (node) => {
        calls.push(node.capability);
        return { status: node.capability === 'fail' ? 'FAILURE' : 'SUCCESS' };
      },
    },
  );

  assert.equal(result.status, 'passed');
  assert.deepEqual(new Set(calls), new Set(['fail', 'ok']));
});

test('ParallelAll max_failures=2 passes when one of three children fails', async () => {
  const calls: string[] = [];
  const result = await executeTree(
    {
      type: 'ParallelAll',
      max_failures: 2,
      children: [
        { type: 'Action', capability: 'fail', adapter: 'test', actor: 'robot' },
        { type: 'Action', capability: 'ok-a', adapter: 'test', actor: 'robot' },
        { type: 'Action', capability: 'ok-b', adapter: 'test', actor: 'robot' },
      ],
    },
    {
      adapter: async (node) => {
        calls.push(node.capability);
        return { status: node.capability === 'fail' ? 'FAILURE' : 'SUCCESS' };
      },
    },
  );

  assert.equal(result.status, 'passed');
  assert.deepEqual(new Set(calls), new Set(['fail', 'ok-a', 'ok-b']));
});

test('RetryUntilSuccessful does not consume attempts while the child is RUNNING', async () => {
  let ticks = 0;
  const result = await executeTree(
    {
      type: 'RetryUntilSuccessful',
      num_attempts: 2,
      child: { type: 'Action', capability: 'flaky', adapter: 'test', actor: 'robot' },
    },
    {
      adapter: async () => {
        ticks += 1;
        if (ticks === 1) {
          await new Promise((resolve) => setImmediate(resolve));
          return { status: 'FAILURE', error: 'not yet' };
        }
        return { status: 'SUCCESS' };
      },
    },
  );

  assert.equal(result.status, 'passed');
  assert.equal(ticks, 2);
});

test('unknown node types are rejected', async () => {
  await assert.rejects(
    () =>
      executeDocument(
        {
          type: 'Unknown',
          children: [{ type: 'Action', capability: 'flaky', adapter: 'test', actor: 'robot' }],
        },
        { adapter: testLeafAdapter },
      ),
    /tree document/,
  );
});

test('blackboard writes are visible to a later sibling on the same run', async () => {
  const seen: unknown[] = [];
  const result = await executeTree(
    {
      type: 'Sequence',
      children: [
        { type: 'Action', adapter: 'test', actor: 'robot', capability: 'write', ports: { name: { key: 'demo.name' } } },
        { type: 'Action', adapter: 'test', actor: 'robot', capability: 'read', ports: { name: { key: 'demo.name' } } },
      ],
    },
    {
      capabilities: [
        {
          adapter: 'test',
          key: 'write',
          kind: 'Action',
          label: 'Write',
          ports: [{ name: 'name', direction: 'out', schema: { type: 'string' } }],
        },
        {
          adapter: 'test',
          key: 'read',
          kind: 'Action',
          label: 'Read',
          ports: [{ name: 'name', direction: 'in', schema: { type: 'string' } }],
        },
      ],
      adapter: async (node, context) => {
        if (node.capability === 'write') {
          return { status: 'SUCCESS', output: { name: 'now' } };
        }
        seen.push(context.input.name);
        return { status: 'SUCCESS' };
      },
    },
  );

  assert.equal(result.status, 'passed');
  assert.deepEqual(seen, ['now']);
});

test('wrapped execute returns RUNNING on the first tick and SUCCESS when the promise settles', async () => {
  const statuses: string[] = [];
  let resolveWork: ((result: NodeStatusResult) => void) | undefined;
  const started = new Promise<void>((resolve) => {
    setImmediate(() => resolve());
  });
  const tree = executeTree(
    { type: 'Action', capability: 'slow', adapter: 'test', actor: 'robot' },
    {
      adapter: () =>
        new Promise<NodeStatusResult>((resolve) => {
          resolveWork = resolve;
        }),
      onProgress: (event) => {
        if (event.path === '') statuses.push(`${event.kind}:${event.kind === 'finished' ? event.status : 'running'}`);
      },
    },
  );
  await started;
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(statuses.includes('started:running'));
  assert.equal(statuses.includes('finished:passed'), false);
  resolveWork!({ status: 'SUCCESS' });
  const result = await tree;
  assert.equal(result.status, 'passed');
  assert.ok(statuses.includes('finished:passed'));
});

test('Repeat(-1) stays running until the tree is canceled', async () => {
  const calls: string[] = [];
  const controller = new AbortController();
  const tree = executeTree(
    {
      type: 'Repeat',
      num_cycles: -1,
      child: { type: 'Action', capability: 'loop', adapter: 'test', actor: 'robot' },
    },
    {
      adapter: async (node: LeafNode) => {
        calls.push(node.capability);
        if (calls.length >= 2) controller.abort(new Error('canceled'));
        return { status: 'SUCCESS' };
      },
      signal: controller.signal,
    },
  );

  const result = await tree;
  assert.equal(result.status, 'canceled');
  assert.ok(calls.includes('loop'));
});

test('_skipIf missing blackboard key is a run accident', async () => {
  await assert.rejects(
    () =>
      executeTree(
        {
          type: 'Fallback',
          children: [
            { type: 'Action', adapter: 'test', actor: 'robot', capability: 'maybe', _skipIf: '{ready} == true' },
            { type: 'Action', adapter: 'test', actor: 'robot', capability: 'after' },
          ],
        },
        {
          adapter: async () => ({ status: 'SUCCESS' }),
        },
      ),
    (error: unknown) => error instanceof WorkerFatalError && /blackboard key ready is missing/.test(error.message),
  );
});

test('_skipIf that cannot compare is a run accident', async () => {
  await assert.rejects(
    () =>
      executeTree(
        {
          type: 'Sequence',
          children: [
            {
              type: 'Action',
              adapter: 'test',
              actor: 'robot',
              capability: 'write',
              ports: { ready: { key: 'ready' } },
            },
            { type: 'Action', adapter: 'test', actor: 'robot', capability: 'maybe', _skipIf: '{ready} < true' },
          ],
        },
        {
          capabilities: [
            {
              adapter: 'test',
              key: 'write',
              kind: 'Action',
              label: 'Write',
              ports: [{ name: 'ready', direction: 'out', schema: { type: 'boolean' } }],
            },
            { adapter: 'test', key: 'maybe', kind: 'Action', label: 'Maybe', ports: [] },
          ],
          adapter: async (node) => {
            if (node.capability === 'write') return { status: 'SUCCESS', output: { ready: true } };
            return { status: 'SUCCESS' };
          },
        },
      ),
    (error: unknown) =>
      error instanceof WorkerFatalError && /precondition comparison requires numbers/.test(error.message),
  );
});

test('_skipIf skips a child and Sequence continues', async () => {
  const calls: string[] = [];
  const result = await executeTree(
    {
      type: 'Sequence',
      children: [
        { type: 'Action', adapter: 'test', actor: 'robot', capability: 'write', ports: { ready: { key: 'ready' } } },
        { type: 'Action', adapter: 'test', actor: 'robot', capability: 'maybe', _skipIf: '{ready} == true' },
        { type: 'Action', adapter: 'test', actor: 'robot', capability: 'after' },
      ],
    },
    {
      capabilities: [
        {
          adapter: 'test',
          key: 'write',
          kind: 'Action',
          label: 'Write',
          ports: [{ name: 'ready', direction: 'out', schema: { type: 'boolean' } }],
        },
        { adapter: 'test', key: 'maybe', kind: 'Action', label: 'Maybe', ports: [] },
        { adapter: 'test', key: 'after', kind: 'Action', label: 'After', ports: [] },
      ],
      adapter: async (node) => {
        calls.push(node.capability);
        if (node.capability === 'write') return { status: 'SUCCESS', output: { ready: true } };
        return { status: 'SUCCESS' };
      },
    },
  );

  assert.equal(result.status, 'passed');
  assert.deepEqual(calls, ['write', 'after']);
});

test('SubTree remap reads and writes the outer blackboard key', async () => {
  const seen: unknown[] = [];
  const result = await executeTree(
    {
      main: 'Main',
      trees: {
        Main: {
          type: 'Sequence',
          children: [
            {
              type: 'Action',
              adapter: 'test',
              actor: 'robot',
              capability: 'write',
              ports: { battery: { key: 'battery' } },
            },
            { type: 'SubTree', id: 'Inner', remap: { battery: { key: 'battery' } } },
          ],
        },
        Inner: {
          type: 'Action',
          adapter: 'test',
          actor: 'robot',
          capability: 'read',
          ports: { battery: { key: 'battery' } },
        },
      },
    },
    {
      capabilities: [
        {
          adapter: 'test',
          key: 'write',
          kind: 'Action',
          label: 'Write',
          ports: [{ name: 'battery', direction: 'out', schema: { type: 'number' } }],
        },
        {
          adapter: 'test',
          key: 'read',
          kind: 'Action',
          label: 'Read',
          ports: [{ name: 'battery', direction: 'in', schema: { type: 'number' } }],
        },
      ],
      adapter: async (node, context) => {
        if (node.capability === 'write') {
          return { status: 'SUCCESS', output: { battery: 7 } };
        }
        seen.push(context.input.battery);
        return { status: 'SUCCESS' };
      },
    },
  );

  assert.equal(result.status, 'passed');
  assert.deepEqual(seen, [7]);
});

test('tick stamps a distinct tree path on each same-capability leaf', async () => {
  const ticks: string[] = [];
  const result = await executeTree(
    {
      type: 'ParallelAll',
      children: [
        { type: 'Action', capability: 'slow', adapter: 'test', actor: 'robot' },
        { type: 'Action', capability: 'slow', adapter: 'test', actor: 'robot' },
      ],
    },
    {
      adapter: async (node) => {
        ticks.push(node.path);
        return { status: 'SUCCESS' };
      },
    },
  );
  assert.equal(result.status, 'passed');
  assert.deepEqual(ticks, ['children.0', 'children.1']);
});

test('haltLeaf receives the tree path of the halted leaf', async () => {
  const halted: string[] = [];
  const waiters: Array<() => void> = [];
  const result = await executeTree(
    {
      type: 'Timeout',
      msec: 1,
      child: { type: 'Action', capability: 'slow', adapter: 'test', actor: 'robot' },
    },
    {
      adapter: async () => {
        await new Promise<void>((resolve) => waiters.push(resolve));
        return { status: 'FAILURE' };
      },
      haltLeaf: async (node) => {
        halted.push(node.path);
        for (const resolve of waiters.splice(0)) resolve();
      },
    },
  );
  assert.equal(result.status, 'failed');
  assert.deepEqual(halted, ['child']);
});

test('haltLeaf is invoked when a running leaf is halted', async () => {
  const halted: string[] = [];
  const controller = new AbortController();
  const tree = executeTree(
    { type: 'Action', capability: 'slow', adapter: 'test', actor: 'robot' },
    {
      adapter: async () => ({ status: 'RUNNING' }),
      haltLeaf: async (node) => {
        halted.push(node.capability);
      },
      signal: controller.signal,
    },
  );
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort(new Error('canceled'));
  const result = await tree;
  assert.equal(result.status, 'canceled');
  assert.deepEqual(halted, ['slow']);
});

test('Condition that settles as RUNNING is a contract failure', async () => {
  await assert.rejects(
    () =>
      executeTree(
        { type: 'Condition', capability: 'not-a-sample', adapter: 'test', actor: 'robot' },
        {
          adapter: async () => ({ status: 'RUNNING' }),
        },
      ),
    (error: unknown) => error instanceof WorkerFatalError && /RUNNING/.test(error.message),
  );
});
