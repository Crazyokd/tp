import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  applyRunProgressEvent,
  createRunTree,
  failedRunError,
  finalizeRunTree,
  findRunNode,
  recordRunProgressEvent,
  stripRunTree,
} from '../src/run-tree.ts';
import { sessionsForLeaves } from '../src/sessions.ts';
import type { CaseDefinition, LeafNode, Run, RunNodeProgressEvent, TreeNode } from '../src/types.ts';

function leaf(capability: string, extra: Partial<LeafNode> = {}): LeafNode {
  return {
    type: extra.type ?? 'Action',
    adapter: extra.adapter ?? 'test',
    actor: extra.actor ?? 'robot',
    capability,
    ports: extra.ports ?? {},
    ...extra,
  };
}

function doc(node: TreeNode, extraTrees: Record<string, TreeNode> = {}): CaseDefinition {
  const trees = { Main: node, ...extraTrees };
  return { main: 'Main', trees, sessions: sessionsForLeaves(trees) };
}

test('createRunTree clones definition shape with pending nodes', () => {
  const definition = doc(
    {
      type: 'Sequence',
      children: [leaf('go'), { type: 'SubTree', id: 'Park' }],
    },
    { Park: leaf('park') },
  );
  const tree = createRunTree(definition);
  assert.equal(tree.main, 'Main');
  assert.equal(tree.trees.Main?.type, 'Sequence');
  assert.equal(tree.trees.Main?.status, 'pending');
  assert.deepEqual(tree.trees.Main?.attempts, []);
  assert.equal(tree.trees.Park?.status, 'pending');
  const stripped = stripRunTree(tree);
  assert.equal(stripped.main, definition.main);
  assert.deepEqual(stripped.trees, definition.trees);
});

test('Run type has tree and no treeProgress', () => {
  const run = {
    id: 'r1',
    batchId: 'batch-1',
    caseId: 'c1',
    status: 'queued',
    createdAt: '2026-09-14T00:00:00.000Z',
    startedAt: null,
    finishedAt: null,
    revision: 0,
    tree: createRunTree(doc(leaf('go'))),
    artifacts: [],
  } satisfies Run;
  assert.equal(run.revision, 0);
  assert.equal('treeProgress' in run, false);
});

test('findRunNode walks Sequence children and SubTree bodies', () => {
  const tree = createRunTree(
    doc(
      {
        type: 'Sequence',
        children: [leaf('go'), { type: 'SubTree', id: 'Park' }],
      },
      { Park: leaf('park') },
    ),
  );
  const child = findRunNode(tree, 'children.0');
  assert.equal(child.type, 'Action');
  assert.equal(child.status, 'pending');
  if (child.type !== 'Action') throw new Error('expected Action');
  assert.equal(child.capability, 'go');
  const park = findRunNode(tree, 'children.1.tree');
  assert.equal(park, tree.trees.Park);
  if (park.type !== 'Action') throw new Error('expected Action');
  assert.equal(park.capability, 'park');
});

test('findRunNode rejects malformed children indices', () => {
  const tree = createRunTree(
    doc(
      {
        type: 'Sequence',
        children: [leaf('go'), { type: 'SubTree', id: 'Park' }],
      },
      { Park: leaf('park') },
    ),
  );
  for (const path of ['children', 'children.', 'children.foo', 'children.00', 'children.0x1', 'children.-1']) {
    assert.throws(() => findRunNode(tree, path), { message: `unknown progress path ${path}` });
  }
});

test('findRunNode walks root, child, and IfThenElse branches', () => {
  const tree = createRunTree(
    doc({
      type: 'IfThenElse',
      if: leaf('check'),
      then: { type: 'Inverter', child: leaf('go') },
      else: leaf('stop'),
    }),
  );
  assert.equal(findRunNode(tree, ''), tree.trees.Main);
  const pred = findRunNode(tree, 'if');
  if (pred.type !== 'Action') throw new Error('expected Action');
  assert.equal(pred.capability, 'check');
  assert.equal(findRunNode(tree, 'then').type, 'Inverter');
  const child = findRunNode(tree, 'then.child');
  if (child.type !== 'Action') throw new Error('expected Action');
  assert.equal(child.capability, 'go');
  const els = findRunNode(tree, 'else');
  if (els.type !== 'Action') throw new Error('expected Action');
  assert.equal(els.capability, 'stop');
});

test('apply start then finish maps SUCCESS onto passed', () => {
  let tree = createRunTree(doc(leaf('go')));
  const started: RunNodeProgressEvent = {
    revision: 1,
    kind: 'started',
    path: '',
    nodeType: 'Action',
    attempt: 1,
    timestamp: '2026-09-14T00:00:01.000Z',
    capability: 'go',
    actor: 'robot',
  };
  tree = applyRunProgressEvent({ revision: 0, tree }, started).tree;
  assert.equal(findRunNode(tree, '').status, 'running');
  tree = applyRunProgressEvent(
    { revision: 1, tree },
    {
      revision: 2,
      kind: 'finished',
      path: '',
      nodeType: 'Action',
      attempt: 1,
      timestamp: '2026-09-14T00:00:02.000Z',
      status: 'passed',
    },
  ).tree;
  assert.equal(findRunNode(tree, '').status, 'passed');
});

test('finalize skips pending and forbids error on canceled', () => {
  const created = createRunTree(doc({ type: 'Sequence', children: [leaf('go')] }));
  const next = finalizeRunTree({ revision: 0, tree: created }, 'canceled');
  assert.equal(next.revision, 1);
  assert.equal(findRunNode(next.tree, '').status, 'skipped');
  assert.equal(findRunNode(next.tree, 'children.0').status, 'skipped');
  assert.throws(() => finalizeRunTree({ revision: 0, tree: created }, 'canceled', 'nope'));
});

test('failedRunError uses latest failed leaf attempt', () => {
  let snapshot = { revision: 0, tree: createRunTree(doc(leaf('go'))) };
  snapshot = applyRunProgressEvent(snapshot, {
    revision: 1,
    kind: 'started',
    path: '',
    nodeType: 'Action',
    attempt: 1,
    timestamp: '2026-09-14T00:00:01.000Z',
    capability: 'go',
    actor: 'robot',
  });
  snapshot = applyRunProgressEvent(snapshot, {
    revision: 2,
    kind: 'finished',
    path: '',
    nodeType: 'Action',
    attempt: 1,
    timestamp: '2026-09-14T00:00:02.000Z',
    status: 'failed',
    error: 'boom',
  });
  assert.equal(failedRunError(snapshot.tree), 'boom');
});

test('apply rejects wrong revision', () => {
  const snapshot = { revision: 0, tree: createRunTree(doc(leaf('go'))) };
  assert.throws(() =>
    applyRunProgressEvent(snapshot, {
      revision: 2,
      kind: 'started',
      path: '',
      nodeType: 'Action',
      attempt: 1,
      timestamp: '2026-09-14T00:00:01.000Z',
      capability: 'go',
      actor: 'robot',
    }),
  );
});

test('Retry two attempts first failed then passed', () => {
  let snapshot = {
    revision: 0,
    tree: createRunTree(
      doc({
        type: 'RetryUntilSuccessful',
        num_attempts: 3,
        child: leaf('go'),
      }),
    ),
  };
  snapshot = applyRunProgressEvent(snapshot, {
    revision: 1,
    kind: 'started',
    path: 'child',
    nodeType: 'Action',
    attempt: 1,
    timestamp: '2026-09-14T00:00:01.000Z',
    capability: 'go',
    actor: 'robot',
  });
  snapshot = applyRunProgressEvent(snapshot, {
    revision: 2,
    kind: 'finished',
    path: 'child',
    nodeType: 'Action',
    attempt: 1,
    timestamp: '2026-09-14T00:00:02.000Z',
    status: 'failed',
    error: 'once',
  });
  snapshot = applyRunProgressEvent(snapshot, {
    revision: 3,
    kind: 'started',
    path: 'child',
    nodeType: 'Action',
    attempt: 2,
    timestamp: '2026-09-14T00:00:03.000Z',
    capability: 'go',
    actor: 'robot',
  });
  snapshot = applyRunProgressEvent(snapshot, {
    revision: 4,
    kind: 'finished',
    path: 'child',
    nodeType: 'Action',
    attempt: 2,
    timestamp: '2026-09-14T00:00:04.000Z',
    status: 'passed',
  });
  const child = findRunNode(snapshot.tree, 'child');
  assert.equal(child.status, 'passed');
  assert.equal(child.attempts.length, 2);
  assert.equal(child.attempts[0]?.status, 'failed');
  assert.equal(child.attempts[1]?.status, 'passed');
});

test('apply rejects wrong nodeType', () => {
  const snapshot = { revision: 0, tree: createRunTree(doc(leaf('go'))) };
  assert.throws(() =>
    applyRunProgressEvent(snapshot, {
      revision: 1,
      kind: 'started',
      path: '',
      nodeType: 'Condition',
      attempt: 1,
      timestamp: '2026-09-14T00:00:01.000Z',
      capability: 'go',
      actor: 'robot',
    }),
  );
});

test('failed finalize closes running attempt as failed with error', () => {
  let snapshot = { revision: 0, tree: createRunTree(doc(leaf('go'))) };
  snapshot = applyRunProgressEvent(snapshot, {
    revision: 1,
    kind: 'started',
    path: '',
    nodeType: 'Action',
    attempt: 1,
    timestamp: '2026-09-14T00:00:01.000Z',
    capability: 'go',
    actor: 'robot',
  });
  const next = finalizeRunTree(snapshot, 'failed', 'halted');
  assert.equal(next.revision, 2);
  const node = findRunNode(next.tree, '');
  assert.equal(node.status, 'failed');
  assert.equal(node.attempts[0]?.status, 'failed');
  assert.equal(node.attempts[0]?.error, 'halted');
  assert.ok(node.attempts[0]?.finishedAt);
  assert.equal(findRunNode(snapshot.tree, '').status, 'running');
});

test('passed finalize with running throws', () => {
  let snapshot = { revision: 0, tree: createRunTree(doc(leaf('go'))) };
  snapshot = applyRunProgressEvent(snapshot, {
    revision: 1,
    kind: 'started',
    path: '',
    nodeType: 'Action',
    attempt: 1,
    timestamp: '2026-09-14T00:00:01.000Z',
    capability: 'go',
    actor: 'robot',
  });
  assert.throws(() => finalizeRunTree(snapshot, 'passed'));
});

test('start then finalize canceled closes running attempt without error', () => {
  let snapshot = { revision: 0, tree: createRunTree(doc(leaf('go'))) };
  snapshot = applyRunProgressEvent(snapshot, {
    revision: 1,
    kind: 'started',
    path: '',
    nodeType: 'Action',
    attempt: 1,
    timestamp: '2026-09-14T00:00:01.000Z',
    capability: 'go',
    actor: 'robot',
  });
  const next = finalizeRunTree(snapshot, 'canceled');
  assert.equal(next.revision, snapshot.revision + 1);
  const node = findRunNode(next.tree, '');
  assert.equal(node.status, 'canceled');
  assert.equal(node.attempts[0]?.status, 'canceled');
  assert.equal('error' in (node.attempts[0] ?? {}), false);
});

test('finalize failed without error or with whitespace throws', () => {
  const snapshot = { revision: 0, tree: createRunTree(doc(leaf('go'))) };
  assert.throws(() => finalizeRunTree(snapshot, 'failed'));
  assert.throws(() => finalizeRunTree(snapshot, 'failed', '   '));
});

test('finalize passed with an error argument throws', () => {
  const snapshot = { revision: 0, tree: createRunTree(doc(leaf('go'))) };
  assert.throws(() => finalizeRunTree(snapshot, 'passed', 'nope'));
});

test('failedRunError throws when the failed attempt has no error', () => {
  let snapshot = { revision: 0, tree: createRunTree(doc(leaf('go'))) };
  snapshot = applyRunProgressEvent(snapshot, {
    revision: 1,
    kind: 'started',
    path: '',
    nodeType: 'Action',
    attempt: 1,
    timestamp: '2026-09-14T00:00:01.000Z',
    capability: 'go',
    actor: 'robot',
  });
  snapshot = applyRunProgressEvent(snapshot, {
    revision: 2,
    kind: 'finished',
    path: '',
    nodeType: 'Action',
    attempt: 1,
    timestamp: '2026-09-14T00:00:02.000Z',
    status: 'failed',
  });
  assert.throws(() => failedRunError(snapshot.tree), /failed run has no failed leaf attempt/);
});

test('failedRunError throws when the tree has no failed leaf', () => {
  const tree = createRunTree(doc(leaf('go')));
  assert.throws(() => failedRunError(tree));
});

test('apply does not mutate the input snapshot tree', () => {
  const snapshot = { revision: 0, tree: createRunTree(doc(leaf('go'))) };
  const before = structuredClone(snapshot);
  applyRunProgressEvent(snapshot, {
    revision: 1,
    kind: 'started',
    path: '',
    nodeType: 'Action',
    attempt: 1,
    timestamp: '2026-09-14T00:00:01.000Z',
    capability: 'go',
    actor: 'robot',
  });
  assert.deepEqual(snapshot, before);
  assert.equal(findRunNode(snapshot.tree, '').status, 'pending');
  assert.deepEqual(findRunNode(snapshot.tree, '').attempts, []);
});

test('owned progress touches only its target and isolates recorded output', () => {
  const snapshot = {
    revision: 0,
    tree: createRunTree(doc({ type: 'Sequence', children: [leaf('go'), leaf('unused')] })),
  };
  Object.defineProperty(findRunNode(snapshot.tree, 'children.1'), 'ports', {
    enumerable: true,
    get: () => assert.fail('progress must not traverse an unrelated branch'),
  });
  recordRunProgressEvent(snapshot, {
    revision: 1,
    kind: 'started',
    path: 'children.0',
    nodeType: 'Action',
    attempt: 1,
    timestamp: '2026-09-14T00:00:01.000Z',
    capability: 'go',
    actor: 'robot',
  });
  const output = { nested: { value: 1 } };
  recordRunProgressEvent(snapshot, {
    revision: 2,
    kind: 'finished',
    path: 'children.0',
    nodeType: 'Action',
    attempt: 1,
    timestamp: '2026-09-14T00:00:02.000Z',
    status: 'passed',
    output,
  });
  output.nested.value = 2;
  assert.equal(snapshot.revision, 2);
  assert.deepEqual(findRunNode(snapshot.tree, 'children.0').attempts[0]?.output, { nested: { value: 1 } });
  assert.equal(findRunNode(snapshot.tree, 'children.1').status, 'pending');
});

test('owned progress rejects invalid events and uncloneable output without partial updates', () => {
  const snapshot = { revision: 0, tree: createRunTree(doc(leaf('go'))) };
  const started = {
    revision: 1,
    kind: 'started' as const,
    path: '',
    nodeType: 'Action' as const,
    attempt: 1,
    timestamp: '2026-09-14T00:00:01.000Z',
    capability: 'go',
    actor: 'robot',
  };
  for (const extra of [{ revision: 2 }, { actor: 'other' }, { attempt: 2 }, { path: 'unknown' }]) {
    const before = structuredClone(snapshot);
    assert.throws(() => recordRunProgressEvent(snapshot, { ...started, ...extra }));
    assert.deepEqual(snapshot, before);
  }
  recordRunProgressEvent(snapshot, started);
  const finished = {
    revision: 2,
    kind: 'finished' as const,
    path: '',
    nodeType: 'Action' as const,
    attempt: 1,
    timestamp: '2026-09-14T00:00:02.000Z',
    status: 'passed' as const,
  };
  for (const extra of [
    { revision: 1 },
    { attempt: 2 },
    { timestamp: '2026-09-14T00:00:00.000Z' },
    { error: ' ' },
    { output: { invalid: undefined } },
    { output: new Proxy({ value: 'ok' }, {}) },
  ]) {
    const before = structuredClone(snapshot);
    assert.throws(() => recordRunProgressEvent(snapshot, { ...finished, ...extra } as RunNodeProgressEvent));
    assert.deepEqual(snapshot, before);
  }
});

test('apply rejects non-ISO timestamp', () => {
  const snapshot = { revision: 0, tree: createRunTree(doc(leaf('go'))) };
  assert.throws(() =>
    applyRunProgressEvent(snapshot, {
      revision: 1,
      kind: 'started',
      path: '',
      nodeType: 'Action',
      attempt: 1,
      timestamp: 'yesterday',
      capability: 'go',
      actor: 'robot',
    }),
  );
});

for (const apply of [
  applyRunProgressEvent,
  (snapshot, event) => {
    recordRunProgressEvent(snapshot, event);
    return snapshot;
  },
])
  test('attempts retention caps stored records but keeps attempt numbering', async () => {
    const { MAX_STORED_RUN_ATTEMPTS } = await import('../src/run-tree.ts');
    const definition = doc({
      type: 'RetryUntilSuccessful',
      num_attempts: -1,
      child: leaf('wait', { type: 'Condition' }),
    });
    let snapshot = { revision: 0, tree: createRunTree(definition) };
    const total = MAX_STORED_RUN_ATTEMPTS + 25;
    const at = (attempt: number, ms: number) =>
      new Date(Date.parse('2026-09-14T00:00:00.000Z') + attempt * 1000 + ms).toISOString();
    for (let attempt = 1; attempt <= total; attempt += 1) {
      const started: RunNodeProgressEvent = {
        revision: snapshot.revision + 1,
        kind: 'started',
        path: 'child',
        nodeType: 'Condition',
        attempt,
        timestamp: at(attempt, 0),
        capability: 'wait',
        actor: 'robot',
      };
      snapshot = apply(snapshot, started);
      snapshot = apply(snapshot, {
        revision: snapshot.revision + 1,
        kind: 'finished',
        path: 'child',
        nodeType: 'Condition',
        attempt,
        timestamp: at(attempt, 500),
        status: 'failed',
        error: `not ready ${attempt}`,
      });
    }
    const node = findRunNode(snapshot.tree, 'child');
    assert.equal(node.attempts.length, MAX_STORED_RUN_ATTEMPTS);
    assert.equal(node.attempts.at(-1)?.attempt, total);
    assert.equal(node.attempts.at(-1)?.error, `not ready ${total}`);
    assert.equal(node.attempts[0]?.attempt, total - MAX_STORED_RUN_ATTEMPTS + 1);
    // 截断后下一次 started 仍按末条编号 +1 校验通过。
    snapshot = apply(snapshot, {
      revision: snapshot.revision + 1,
      kind: 'started',
      path: 'child',
      nodeType: 'Condition',
      attempt: total + 1,
      timestamp: at(total + 1, 0),
      capability: 'wait',
      actor: 'robot',
    });
    assert.equal(findRunNode(snapshot.tree, 'child').attempts.at(-1)?.attempt, total + 1);
  });
