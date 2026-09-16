import assert from 'node:assert/strict';
import { test } from 'node:test';

import { executeTree as executeDocument, WorkerFatalError } from '../src/bt.ts';
import {
  applyRunProgressEvent,
  createRunTree,
  failedRunError,
  findRunNode,
  type CaseDefinition,
  type RunNode,
  type RunNodeProgressEvent,
  type RunTreeSnapshot,
  type TreeNode,
} from '@tp/contract';
import { caseDef, leafCapabilities, testLeafAdapter } from './case-def.ts';

function executeTree(definition: TreeNode | CaseDefinition, options?: Parameters<typeof executeDocument>[1]) {
  return executeDocument(caseDef(definition), {
    adapter: testLeafAdapter,
    capabilities: leafCapabilities(definition),
    ...options,
  });
}

function createProgressSnapshot(definition: TreeNode | CaseDefinition): RunTreeSnapshot {
  return { revision: 0, tree: createRunTree(caseDef(definition)) };
}

function walkStatuses(node: RunNode): string[] {
  const statuses = [node.status];
  if ('children' in node) {
    for (const child of node.children) statuses.push(...walkStatuses(child));
  } else if (node.type === 'IfThenElse' || node.type === 'WhileDoElse') {
    statuses.push(...walkStatuses(node.if), ...walkStatuses(node.then));
    if (node.else) statuses.push(...walkStatuses(node.else));
  } else if ('child' in node) {
    statuses.push(...walkStatuses(node.child));
  }
  return statuses;
}

function eventShape(event: RunNodeProgressEvent) {
  return [
    event.revision,
    event.kind,
    event.path,
    event.nodeType,
    event.attempt,
    event.kind === 'finished' ? event.status : undefined,
  ];
}

function hangingLeaf() {
  const waiters: Array<() => void> = [];
  return {
    adapter: async () => {
      await new Promise<void>((resolve) => waiters.push(resolve));
      return { status: 'FAILURE' as const };
    },
    haltLeaf: async () => {
      for (const resolve of waiters.splice(0)) resolve();
    },
  };
}

async function executeWithProgress(
  definition: unknown,
  adapter?: Parameters<typeof executeTree>[1]['adapter'],
  extra?: Omit<NonNullable<Parameters<typeof executeTree>[1]>, 'adapter' | 'onProgress'>,
) {
  const events: RunNodeProgressEvent[] = [];
  const result = await executeTree(definition, {
    ...extra,
    ...(adapter ? { adapter } : {}),
    onProgress: async (event) => {
      await Promise.resolve();
      events.push(event);
    },
  });
  return { result, events };
}

test('sequence runs actions in order and records node results', async () => {
  const calls = [];
  const result = await executeTree(
    {
      type: 'Sequence',
      children: [
        {
          type: 'Action',
          capability: 'demo.mapping.start',
          adapter: 'demo',
          actor: 'robot',
          ports: { mapName: { literal: 'demo' } },
        },
        { type: 'Condition', capability: 'demo.localization.ready', adapter: 'demo', actor: 'robot' },
      ],
    },
    {
      adapter: async (node) => {
        calls.push(node.capability);
        return { status: 'SUCCESS' };
      },
    },
  );

  assert.equal(result.status, 'passed');
  assert.equal('error' in result, false);
  assert.equal('nodes' in result, false);
  assert.deepEqual(calls, ['demo.mapping.start', 'demo.localization.ready']);
});

test('sequence stops at the first failing action', async () => {
  const calls = [];
  const result = await executeTree(
    {
      type: 'Sequence',
      children: [
        {
          type: 'Action',
          capability: 'demo.mapping.start',
          adapter: 'demo',
          actor: 'robot',
          ports: { mapName: { literal: 'sequence-test' } },
        },
        { type: 'Action', capability: 'demo.fail', adapter: 'demo', actor: 'robot' },
        { type: 'Action', capability: 'demo.never', adapter: 'demo', actor: 'robot' },
      ],
    },
    {
      adapter: async (node) => {
        calls.push(node.capability);
        return { status: node.capability === 'demo.fail' ? 'FAILURE' : 'SUCCESS' };
      },
    },
  );

  assert.equal(result.status, 'failed');
  assert.deepEqual(calls, ['demo.mapping.start', 'demo.fail']);
});

test('selector stops at the first passing child', async () => {
  const calls = [];
  const result = await executeTree(
    {
      type: 'Fallback',
      children: [
        { type: 'Action', capability: 'demo.fail', adapter: 'demo', actor: 'robot' },
        { type: 'Action', capability: 'demo.recover', adapter: 'demo', actor: 'robot' },
        { type: 'Action', capability: 'demo.never', adapter: 'demo', actor: 'robot' },
      ],
    },
    {
      adapter: async (node) => {
        calls.push(node.capability);
        return { status: node.capability === 'demo.recover' ? 'SUCCESS' : 'FAILURE' };
      },
    },
  );

  assert.equal(result.status, 'passed');
  assert.deepEqual(calls, ['demo.fail', 'demo.recover']);
});

test('parallel all fails when any child fails', async () => {
  const result = await executeTree({
    type: 'ParallelAll',
    children: [
      { type: 'Action', capability: 'demo.ok', adapter: 'demo', actor: 'robot' },
      { type: 'Action', capability: 'demo.fail', adapter: 'demo', actor: 'robot' },
    ],
  });

  assert.equal(result.status, 'failed');
  assert.equal('error' in result, false);
});

test('retry reruns a failing child until it passes', async () => {
  let attempts = 0;
  const result = await executeTree(
    {
      type: 'RetryUntilSuccessful',
      num_attempts: 3,
      child: { type: 'Condition', capability: 'demo.eventually_ready', adapter: 'demo', actor: 'robot' },
    },
    {
      adapter: async () => {
        attempts += 1;
        return { status: attempts === 3 ? 'SUCCESS' : 'FAILURE' };
      },
    },
  );

  assert.equal(result.status, 'passed');
  assert.equal(attempts, 3);
});

test('inverter flips a passing child to failed', async () => {
  const result = await executeTree(
    {
      type: 'Inverter',
      child: { type: 'Action', capability: 'demo.pass', adapter: 'demo', actor: 'robot' },
    },
    {
      adapter: async () => ({ status: 'SUCCESS' }),
    },
  );

  assert.equal(result.status, 'failed');
  assert.equal('error' in result, false);
});

test('inverter flips a failing child to passed', async () => {
  const result = await executeTree(
    {
      type: 'Inverter',
      child: { type: 'Condition', capability: 'demo.fail', adapter: 'demo', actor: 'robot' },
    },
    {
      adapter: async () => ({ status: 'FAILURE', error: 'not ready' }),
    },
  );

  assert.equal(result.status, 'passed');
});

test('inverter does not flip a child aborted by Timeout', async () => {
  const hanging = hangingLeaf();
  const { result, events } = await executeWithProgress(
    {
      type: 'Timeout',
      msec: 1,
      child: {
        type: 'Inverter',
        child: { type: 'Action', capability: 'demo.slow', adapter: 'demo', actor: 'robot' },
      },
    },
    hanging.adapter,
    { haltLeaf: hanging.haltLeaf },
  );

  assert.equal(result.status, 'failed');
  assert.deepEqual(events.filter((event) => event.path === 'child' && event.kind === 'finished').map(eventShape), [
    [5, 'finished', 'child', 'Inverter', 1, 'failed'],
  ]);
});

test('inverter progress starts itself, then the child, then finishes inverted', async () => {
  const { events } = await executeWithProgress(
    {
      type: 'Inverter',
      child: { type: 'Action', capability: 'demo.fail', adapter: 'demo', actor: 'robot' },
    },
    async () => ({ status: 'FAILURE' }),
  );

  assert.deepEqual(events.map(eventShape), [
    [1, 'started', '', 'Inverter', 1, undefined],
    [2, 'started', 'child', 'Action', 1, undefined],
    [3, 'finished', 'child', 'Action', 1, 'failed'],
    [4, 'finished', '', 'Inverter', 1, 'passed'],
  ]);
});

test('timeout fails a slow child', async () => {
  let aborted = false;
  const hanging = hangingLeaf();
  const result = await executeTree(
    {
      type: 'Timeout',
      msec: 1,
      child: { type: 'Action', capability: 'demo.slow', adapter: 'demo', actor: 'robot' },
    },
    {
      adapter: hanging.adapter,
      haltLeaf: async (leaf) => {
        aborted = true;
        await hanging.haltLeaf(leaf);
      },
    },
  );

  assert.equal(result.status, 'failed');
  assert.equal(aborted, true);
});

test('progress reports Sequence nodes in exact path and revision order', async () => {
  const { events } = await executeWithProgress({
    type: 'Sequence',
    children: [
      { type: 'Action', capability: 'demo.one', adapter: 'demo', actor: 'robot-1' },
      { type: 'Condition', capability: 'demo.two', adapter: 'demo', actor: 'robot' },
    ],
  });

  assert.deepEqual(events.map(eventShape), [
    [1, 'started', '', 'Sequence', 1, undefined],
    [2, 'started', 'children.0', 'Action', 1, undefined],
    [3, 'finished', 'children.0', 'Action', 1, 'passed'],
    [4, 'started', 'children.1', 'Condition', 1, undefined],
    [5, 'finished', 'children.1', 'Condition', 1, 'passed'],
    [6, 'finished', '', 'Sequence', 1, 'passed'],
  ]);
  assert.deepEqual(events[1], {
    revision: 2,
    kind: 'started',
    path: 'children.0',
    nodeType: 'Action',
    attempt: 1,
    timestamp: events[1]!.timestamp,
    capability: 'demo.one',
    actor: 'robot-1',
  });
  assert.equal(new Date(events[1]!.timestamp).toISOString(), events[1]!.timestamp);
});

test('progress omits Fallback children skipped after a passing child', async () => {
  const { events } = await executeWithProgress(
    {
      type: 'Fallback',
      children: [
        { type: 'Condition', capability: 'demo.ready', adapter: 'demo', actor: 'robot' },
        { type: 'Action', capability: 'demo.never', adapter: 'demo', actor: 'robot' },
      ],
    },
    async () => ({ status: 'SUCCESS' }),
  );

  assert.deepEqual(
    events.map((event) => event.path),
    ['', 'children.0', 'children.0', ''],
  );
  assert.equal(
    events.some((event) => event.path === 'children.1'),
    false,
  );
});

test('progress starts all ParallelAll children before any child finishes', async () => {
  const releases: Array<() => void> = [];
  const definition = {
    type: 'ParallelAll',
    children: [
      { type: 'Action', capability: 'demo.one', adapter: 'demo', actor: 'robot' },
      { type: 'Action', capability: 'demo.two', adapter: 'demo', actor: 'robot' },
    ],
  };
  const execution = executeWithProgress(definition, async () => {
    await new Promise<void>((resolve) => releases.push(resolve));
    return { status: 'SUCCESS' };
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(releases.length, 2);
  releases.forEach((release) => release());
  const { events } = await execution;

  const childStarts = events.filter((event) => event.kind === 'started' && event.path !== '');
  const firstChildFinish = events.findIndex((event) => event.kind === 'finished' && event.path !== '');
  assert.deepEqual(
    childStarts.map((event) => event.path),
    ['children.0', 'children.1'],
  );
  assert.ok(childStarts.every((event) => events.indexOf(event) < firstChildFinish));
});

test('ParallelAll treats a thrown tick as a run accident', async () => {
  await assert.rejects(
    () =>
      executeTree(
        {
          type: 'ParallelAll',
          children: [
            { type: 'Action', capability: 'demo.throw', adapter: 'demo', actor: 'robot' },
            { type: 'Action', capability: 'demo.slow', adapter: 'demo', actor: 'robot' },
          ],
        },
        {
          adapter: async (node) => {
            if (node.capability === 'demo.throw') throw new Error('parallel boom');
            return { status: 'SUCCESS' };
          },
        },
      ),
    (error: unknown) => error instanceof WorkerFatalError && /parallel boom/.test(error.message),
  );
});

test('Parallel halts a pending sibling after Timeout failure', async () => {
  const calls: string[] = [];
  const hanging = hangingLeaf();
  const result = await executeTree(
    {
      type: 'Parallel',
      children: [
        {
          type: 'Timeout',
          msec: 1,
          child: { type: 'Action', capability: 'demo.fatal', adapter: 'demo', actor: 'robot' },
        },
        { type: 'Action', capability: 'demo.pending', adapter: 'demo', actor: 'robot' },
      ],
    },
    {
      adapter: async (node) => {
        calls.push(node.capability);
        return hanging.adapter(node, { input: {} });
      },
      haltLeaf: hanging.haltLeaf,
    },
  );
  assert.equal(result.status, 'failed');
  assert.ok(calls.includes('demo.fatal'));
});

test('progress increments Retry child and descendant attempts on every run', async () => {
  let calls = 0;
  const { events } = await executeWithProgress(
    {
      type: 'RetryUntilSuccessful',
      num_attempts: 3,
      child: {
        type: 'Sequence',
        children: [{ type: 'Condition', capability: 'demo.eventual', adapter: 'demo', actor: 'robot' }],
      },
    },
    async () => ({ status: ++calls === 3 ? 'SUCCESS' : 'FAILURE' }),
  );

  for (const path of ['child', 'child.children.0']) {
    assert.deepEqual(
      events.filter((event) => event.path === path).map((event) => [event.kind, event.attempt]),
      [
        ['started', 1],
        ['finished', 1],
        ['started', 2],
        ['finished', 2],
        ['started', 3],
        ['finished', 3],
      ],
    );
  }
  assert.deepEqual(events.filter((event) => event.path === '').map(eventShape), [
    [1, 'started', '', 'RetryUntilSuccessful', 1, undefined],
    [14, 'finished', '', 'RetryUntilSuccessful', 1, 'passed'],
  ]);
});

test('progress reports the aborted adapter result before the failed Timeout decorator', async () => {
  const hanging = hangingLeaf();
  const { events } = await executeWithProgress(
    {
      type: 'Timeout',
      msec: 1,
      child: { type: 'Condition', capability: 'demo.slow', adapter: 'demo', actor: 'robot' },
    },
    hanging.adapter,
    { haltLeaf: hanging.haltLeaf },
  );

  assert.deepEqual(events.map(eventShape), [
    [1, 'started', '', 'Timeout', 1, undefined],
    [2, 'started', 'child', 'Condition', 1, undefined],
    [3, 'finished', 'child', 'Condition', 1, 'failed'],
    [4, 'finished', '', 'Timeout', 1, 'failed'],
  ]);
});

test('adapter throw is a run accident and does not become leaf FAILURE', async () => {
  const events: RunNodeProgressEvent[] = [];
  await assert.rejects(
    () =>
      executeTree(
        {
          type: 'Sequence',
          children: [{ type: 'Action', capability: 'demo.throw', adapter: 'demo', actor: 'robot' }],
        },
        {
          adapter: async () => {
            throw new Error('adapter boom');
          },
          onProgress: (event) => events.push(event),
        },
      ),
    (error: unknown) => error instanceof WorkerFatalError && error.message === 'adapter boom',
  );
  assert.deepEqual(
    events.map((event) => [event.kind, event.path]),
    [
      ['started', ''],
      ['started', 'children.0'],
    ],
  );
});

test('blank adapter throws preserve summary errors but normalize run-progress errors', async () => {
  for (const [thrown, summaryError, treeError] of [
    ['', '', undefined],
    [new Error(), '', undefined],
    [{ toString: () => '   ' }, '   ', '   '],
  ] as const) {
    const definition = { type: 'Action', capability: 'demo.blank-throw', adapter: 'demo', actor: 'robot' };
    let progress = createProgressSnapshot(definition);
    await assert.rejects(
      () =>
        executeTree(definition, {
          adapter: async () => {
            throw thrown;
          },
          onProgress: (event) => {
            progress = applyRunProgressEvent(progress, event);
          },
        }),
      WorkerFatalError,
    );
    assert.equal(progress.revision, 1);
    void summaryError;
    void treeError;
  }
});

test('hostile thrown values cannot cause a secondary error while formatting execution errors', async () => {
  const hostile = {
    [Symbol.toPrimitive]: () => {
      throw new Error('symbol conversion exploded');
    },
    toString: () => {
      throw new Error('string conversion exploded');
    },
  };
  const definition = { type: 'Action', capability: 'demo.hostile-throw', adapter: 'demo', actor: 'robot' };
  let progress = createProgressSnapshot(definition);
  await assert.rejects(
    () =>
      executeTree(definition, {
        adapter: async () => {
          throw hostile;
        },
        onProgress: (event) => {
          progress = applyRunProgressEvent(progress, event);
        },
      }),
    WorkerFatalError,
  );
  assert.equal(progress.revision, 1);
});

test('failed adapter results expose cloneable output and a string progress error', async () => {
  const definition = { type: 'Action' as const, capability: 'demo.fail', adapter: 'demo', actor: 'robot' };
  const { events } = await executeWithProgress(
    definition,
    async () => ({ status: 'FAILURE', output: { code: 42, error: 'not ready' } }),
    {
      capabilities: leafCapabilities(definition, [
        { name: 'code', direction: 'out', schema: { type: 'number' }, required: false },
        { name: 'error', direction: 'out', schema: { type: 'string' }, required: false },
      ]),
    },
  );
  const finished = events[1]!;
  assert.equal(finished.kind, 'finished');
  if (finished.kind === 'finished') {
    assert.deepEqual(finished.output, { code: 42, error: 'not ready' });
    assert.equal(finished.error, 'not ready');
    assert.doesNotThrow(() => structuredClone(finished));
  }
});

test('progress callback output mutation cannot change stored attempt output', async () => {
  const definition = { type: 'Action' as const, capability: 'demo.output-alias', adapter: 'demo', actor: 'robot' };
  let progress = createProgressSnapshot(definition);
  const result = await executeTree(definition, {
    capabilities: leafCapabilities(definition, [
      {
        name: 'nested',
        direction: 'out',
        schema: { type: 'object', properties: { values: { type: 'array', items: { type: 'number' } } } },
        required: false,
      },
    ]),
    adapter: async () => ({
      status: 'SUCCESS',
      output: { nested: { values: [1, 2, 3] } },
    }),
    onProgress: (event) => {
      progress = applyRunProgressEvent(progress, event);
      if (event.kind !== 'finished' || event.output === undefined) return;
      (event.output.nested as { values: number[] }).values[0] = 99;
      event.output.extra = 'callback-only';
    },
  });

  assert.equal(result.status, 'passed');
  assert.deepEqual(findRunNode(progress.tree, '').attempts[0]?.output, {
    nested: { values: [1, 2, 3] },
  });
});

test('progress callback rejection stops execution and is not covered by false finishes', async () => {
  const events: RunNodeProgressEvent[] = [];
  const callbackError = new Error('progress boom');
  await assert.rejects(
    executeTree(
      {
        type: 'Sequence',
        children: [{ type: 'Action', capability: 'demo.never', adapter: 'demo', actor: 'robot' }],
      },
      {
        adapter: async () => {
          assert.fail('adapter must not run');
        },
        onProgress: async (event) => {
          events.push(event);
          if (event.path === 'children.0' && event.kind === 'started') throw callbackError;
        },
      },
    ),
    (error) => error === callbackError,
  );
  assert.deepEqual(events.map(eventShape), [
    [1, 'started', '', 'Sequence', 1, undefined],
    [2, 'started', 'children.0', 'Action', 1, undefined],
  ]);
});

test('executeTree progress events are all accepted by the run-progress reducer', async () => {
  const definition: CaseDefinition = {
    type: 'RetryUntilSuccessful',
    num_attempts: 2,
    child: { type: 'Action', capability: 'demo.reducer', adapter: 'demo', actor: 'robot-2' },
  };
  let progress = createProgressSnapshot(definition);
  let attempts = 0;
  await executeTree(definition, {
    capabilities: leafCapabilities(definition, [
      { name: 'attempt', direction: 'out', schema: { type: 'number' }, required: false },
    ]),
    adapter: async () => ({
      status: ++attempts === 2 ? 'SUCCESS' : 'FAILURE',
      output: { attempt: attempts },
    }),
    onProgress: (event) => {
      progress = applyRunProgressEvent(progress, event);
    },
  });

  assert.equal(progress.revision, 6);
  assert.equal(
    walkStatuses(progress.tree.trees.Main!).every((status) => status === 'passed'),
    true,
  );
});

test('run-progress accepts every attempt when Retry wraps Timeout', async () => {
  const definition: CaseDefinition = {
    type: 'RetryUntilSuccessful',
    num_attempts: 2,
    child: {
      type: 'Timeout',
      msec: 1,
      child: { type: 'Condition', capability: 'demo.retry-timeout', adapter: 'demo', actor: 'robot' },
    },
  };
  let progress = createProgressSnapshot(definition);
  const hanging = hangingLeaf();
  await executeTree(definition, {
    adapter: hanging.adapter,
    haltLeaf: hanging.haltLeaf,
    onProgress: (event) => {
      progress = applyRunProgressEvent(progress, event);
    },
  });

  assert.equal(progress.revision, 10);
  assert.deepEqual(
    findRunNode(progress.tree, 'child.child').attempts.map(({ attempt, status }) => [attempt, status]),
    [
      [1, 'failed'],
      [2, 'failed'],
    ],
  );
});

test('generated timestamps stay nondecreasing when the injected wall clock moves backward', async () => {
  const definition: CaseDefinition = {
    type: 'Sequence',
    children: [{ type: 'Action', capability: 'demo.clock', adapter: 'demo', actor: 'robot' }],
  };
  const wallTimes = [1000, 900, 800, 700, 600];
  const events: RunNodeProgressEvent[] = [];
  let progress = createProgressSnapshot(definition);
  const result = await executeTree(definition, {
    now: () => wallTimes.shift() ?? 0,
    adapter: async () => ({ status: 'SUCCESS' }),
    onProgress: (event) => {
      events.push(event);
      progress = applyRunProgressEvent(progress, event);
    },
  });

  assert.deepEqual(
    events.map((event) => event.timestamp),
    ['1970-01-01T00:00:01.000Z', '1970-01-01T00:00:01.000Z', '1970-01-01T00:00:01.000Z', '1970-01-01T00:00:01.000Z'],
  );
  assert.equal(progress.revision, 4);
  assert.equal(result.status, 'passed');
  assert.equal(findRunNode(progress.tree, 'children.0').attempts[0]!.startedAt, '1970-01-01T00:00:01.000Z');
  assert.equal(findRunNode(progress.tree, 'children.0').attempts[0]!.finishedAt, '1970-01-01T00:00:01.000Z');
});

test('executeTree error is the last failed leaf, not an earlier retried failure', async () => {
  let readyAttempts = 0;
  const definition = {
    type: 'Sequence' as const,
    children: [
      {
        type: 'RetryUntilSuccessful' as const,
        num_attempts: -1,
        child: { type: 'Condition' as const, capability: 'demo.system.ready', adapter: 'demo', actor: 'robot' },
      },
      { type: 'Action' as const, capability: 'demo.mapping.drive_to_pose', adapter: 'demo', actor: 'robot' },
    ],
  };
  let progress = createProgressSnapshot(definition);
  const result = await executeTree(definition, {
    capabilities: leafCapabilities(definition, [
      { name: 'error', direction: 'out', schema: { type: 'string' }, required: false },
      { name: 'ready', direction: 'out', schema: { type: 'boolean' }, required: false },
    ]),
    adapter: async (node) => {
      if (node.capability === 'demo.system.ready') {
        readyAttempts += 1;
        return readyAttempts < 3
          ? { status: 'FAILURE', output: { error: 'Demo system is not ready' } }
          : { status: 'SUCCESS', output: { ready: true } };
      }
      return { status: 'FAILURE', output: { error: 'Unknown motion stream id motion-1' } };
    },
    onProgress: (event) => {
      progress = applyRunProgressEvent(progress, event);
    },
  });

  assert.equal(result.status, 'failed');
  assert.equal('error' in result, false);
  assert.equal(failedRunError(progress.tree), 'Unknown motion stream id motion-1');
  assert.ok(readyAttempts >= 3);
});

test('executeTree result remains leaf-only and strips progress state', async () => {
  const result = await executeTree(
    {
      type: 'Sequence',
      children: [{ type: 'Action', capability: 'demo.leaf', adapter: 'demo', actor: 'robot' }],
    },
    { onProgress: () => undefined },
  );

  assert.deepEqual(result, { status: 'passed' });
  assert.doesNotThrow(() => structuredClone(result));
});

test('canceled executeTree returns status only', async () => {
  const controller = new AbortController();
  const hanging = hangingLeaf();
  const result = await executeTree(
    { type: 'Action', capability: 'demo.slow', adapter: 'demo', actor: 'robot' },
    {
      adapter: hanging.adapter,
      haltLeaf: hanging.haltLeaf,
      signal: controller.signal,
      onProgress: (event) => {
        if (event.kind === 'started' && event.path === '') controller.abort();
      },
    },
  );

  assert.deepEqual(result, { status: 'canceled' });
});

test('executeTree rejects a structurally illegal tree document', async () => {
  await assert.rejects(
    () =>
      executeDocument(
        { main: 'Main', trees: { Main: { type: 'Sequence', children: [] } } },
        { adapter: testLeafAdapter },
      ),
    /children/,
  );
});

test('executeTree requires an adapter', async () => {
  await assert.rejects(
    () =>
      executeDocument(caseDef({ type: 'Action', capability: 'ok', adapter: 'test', actor: 'robot' }), {
        adapter: undefined as never,
      }),
    /adapter is required/,
  );
});

test('a leaf without a registered capability is a run accident', async () => {
  await assert.rejects(
    () =>
      executeDocument(caseDef({ type: 'Action', capability: 'ok', adapter: 'test', actor: 'robot' }), {
        adapter: testLeafAdapter,
        capabilities: [],
      }),
    /not registered/,
  );
});
