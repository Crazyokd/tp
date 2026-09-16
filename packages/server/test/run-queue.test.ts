import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createRunQueue } from '../src/run-queue.ts';
import { createRunTree, findRunNode, type CaseDefinition, type LiveRun, type RunNodeProgressEvent } from '@tp/contract';
import { caseDef } from './case-def.ts';

function queuedRun(
  id: string,
  definition: CaseDefinition = caseDef({
    type: 'Action',
    adapter: 'demo',
    actor: 'robot',
    capability: 'demo.mapping.start',
    ports: { mapName: { literal: `map-${id}` } },
  }),
): LiveRun {
  return {
    id,
    caseId: `case-${id}`,
    status: 'queued',
    createdAt: '2026-09-09T00:00:00.000Z',
    startedAt: null,
    finishedAt: null,
    revision: 0,
    tree: createRunTree(definition),
    artifacts: [],
    definition,
  };
}

test('workers claim queued runs in FIFO order without worker identity', () => {
  const queue = createRunQueue();
  queue.enqueue(queuedRun('first'));
  queue.enqueue(queuedRun('second'));

  const claimed = queue.claimNext();

  assert.equal(claimed?.id, 'first');
  assert.equal(claimed?.status, 'running');
  assert.ok(claimed?.startedAt);
  assert.equal('workerId' in claimed, false);
  assert.deepEqual(
    queue.list().map((run) => [run.id, run.status]),
    [
      ['first', 'running'],
      ['second', 'queued'],
    ],
  );
});

test('completing an active run removes it from the memory queue', () => {
  const queue = createRunQueue();
  queue.enqueue(queuedRun('run-1'));
  queue.claimNext();

  const completed = queue.complete('run-1');

  assert.equal(completed.id, 'run-1');
  assert.deepEqual(queue.list(), []);
});

test('the memory queue applies backpressure at its configured capacity', () => {
  const queue = createRunQueue({ capacity: 1 });
  queue.enqueue(queuedRun('first'));

  assert.throws(() => queue.enqueue(queuedRun('second')), /run queue capacity 1 exceeded/);
});

test('applies progress to the one internal snapshot with clone-isolated reads', () => {
  const queue = createRunQueue();
  queue.enqueue(queuedRun('run-1'));
  queue.claimNext();
  const event: RunNodeProgressEvent = {
    revision: 1,
    kind: 'started',
    path: '',
    nodeType: 'Action',
    capability: 'demo.mapping.start',
    actor: 'robot',
    attempt: 1,
    timestamp: '2026-09-10T00:00:00.000Z',
  };

  const applied = queue.applyProgress('run-1', event);
  assert.equal(applied.id, 'run-1');
  assert.equal(applied.revision, 1);
  findRunNode(applied.tree, '').status = 'failed';
  findRunNode(queue.get('run-1').tree, '').status = 'canceled';
  findRunNode(queue.list()[0]!.tree, '').attempts[0]!.status = 'failed';

  assert.equal(queue.get('run-1').revision, 1);
  assert.equal(findRunNode(queue.get('run-1').tree, '').status, 'running');
  assert.equal(findRunNode(queue.get('run-1').tree, '').attempts[0]!.status, 'running');
});

test('markCanceling transitions only a running run to canceling', () => {
  const queue = createRunQueue();
  queue.enqueue(queuedRun('run-1'));

  assert.throws(() => queue.markCanceling('run-1'), /not running/);
  queue.claimNext();
  const canceling = queue.markCanceling('run-1');

  assert.equal(canceling.status, 'canceling');
  assert.equal(queue.get('run-1').status, 'canceling');
  assert.equal('definition' in canceling, true);
  assert.throws(() => queue.markCanceling('run-1'), /not running/);
});

test('applies progress while canceling so halt can still finish nodes', () => {
  const queue = createRunQueue();
  queue.enqueue(queuedRun('run-1'));
  queue.claimNext();
  queue.markCanceling('run-1');
  const started: RunNodeProgressEvent = {
    revision: 1,
    kind: 'started',
    path: '',
    nodeType: 'Action',
    capability: 'demo.mapping.start',
    actor: 'robot',
    attempt: 1,
    timestamp: '2026-09-10T00:00:00.000Z',
  };
  const finished: RunNodeProgressEvent = {
    revision: 2,
    kind: 'finished',
    path: '',
    nodeType: 'Action',
    attempt: 1,
    timestamp: '2026-09-10T00:00:01.000Z',
    status: 'canceled',
  };

  const applied = queue.applyProgress('run-1', started);
  assert.equal(applied.status, 'canceling');
  assert.equal(applied.revision, 1);
  queue.applyProgress('run-1', finished);

  const completed = queue.complete('run-1');
  assert.equal(completed.id, 'run-1');
  assert.equal(completed.status, 'canceling');
  assert.equal(findRunNode(completed.tree, '').status, 'canceled');
  assert.deepEqual(queue.list(), []);
});

test('strictly rejects queued, unknown-run, duplicate-revision, and wrong-path progress', () => {
  const queue = createRunQueue();
  queue.enqueue(queuedRun('run-1'));
  const event: RunNodeProgressEvent = {
    revision: 1,
    kind: 'started',
    path: '',
    nodeType: 'Action',
    capability: 'demo.mapping.start',
    actor: 'robot',
    attempt: 1,
    timestamp: '2026-09-10T00:00:00.000Z',
  };

  assert.throws(() => queue.applyProgress('run-1', event), /not running/);
  queue.claimNext();
  assert.throws(() => queue.applyProgress('other', event), /active run other not found/);
  queue.applyProgress('run-1', event);
  assert.throws(() => queue.applyProgress('run-1', event), /expected revision 2/);
  assert.throws(
    () => queue.applyProgress('run-1', { ...event, revision: 2, path: 'unknown' }),
    /unknown progress path/,
  );
  assert.equal(queue.get('run-1').revision, 1);
});

test('applyArtifact appends to the live run and bumps revision', () => {
  const queue = createRunQueue();
  queue.enqueue(queuedRun('r1'));
  queue.claimNext();
  const next = queue.applyArtifact('r1', {
    revision: 1,
    artifact: { id: 'a1', name: 'n', mediaType: 'text/plain' },
  });
  assert.equal(next.revision, 1);
  assert.deepEqual(next.artifacts, [{ id: 'a1', name: 'n', mediaType: 'text/plain' }]);
});

test('tracks parallel and retry progress events in revision order', () => {
  const definition = caseDef({
    type: 'ParallelAll',
    children: [
      { type: 'Action', capability: 'demo.mapping.stop', adapter: 'demo', actor: 'robot' },
      {
        type: 'RetryUntilSuccessful',
        num_attempts: 2,
        child: { type: 'Action', capability: 'demo.mapping.stop', adapter: 'demo', actor: 'robot' },
      },
    ],
  });
  const queue = createRunQueue();
  queue.enqueue(queuedRun('run-1', definition));
  queue.claimNext();
  const events: RunNodeProgressEvent[] = [
    {
      revision: 1,
      kind: 'started',
      path: 'children.0',
      nodeType: 'Action',
      capability: 'demo.mapping.stop',
      actor: 'robot',
      attempt: 1,
      timestamp: '2026-09-10T00:00:00.000Z',
    },
    {
      revision: 2,
      kind: 'started',
      path: 'children.1.child',
      nodeType: 'Action',
      capability: 'demo.mapping.stop',
      actor: 'robot',
      attempt: 1,
      timestamp: '2026-09-10T00:00:00.000Z',
    },
    {
      revision: 3,
      kind: 'finished',
      path: 'children.1.child',
      nodeType: 'Action',
      attempt: 1,
      timestamp: '2026-09-10T00:00:01.000Z',
      status: 'failed',
      error: 'retry',
    },
    {
      revision: 4,
      kind: 'started',
      path: 'children.1.child',
      nodeType: 'Action',
      capability: 'demo.mapping.stop',
      actor: 'robot',
      attempt: 2,
      timestamp: '2026-09-10T00:00:02.000Z',
    },
  ];
  for (const event of events) queue.applyProgress('run-1', event);

  const live = queue.get('run-1');
  assert.equal(live.revision, 4);
  assert.equal(findRunNode(live.tree, 'children.0').status, 'running');
  assert.deepEqual(
    findRunNode(live.tree, 'children.1.child').attempts.map(({ status }) => status),
    ['failed', 'running'],
  );
});
