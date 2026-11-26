import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';

import { createRunTree, type Run } from '@tp/contract';

import { createRunWatchHub, parseLastEventId, toSseRun } from '../src/sse.ts';

const definition = {
  main: 'Main',
  trees: {
    Main: {
      type: 'Action' as const,
      adapter: 'test',
      actor: 'robot',
      capability: 'test.pass',
    },
  },
  sessions: [],
};

function run(overrides: Partial<Run> = {}): Run {
  return {
    id: 'run-1',
    batchId: 'batch-1',
    caseId: 'case-1',
    status: 'queued',
    createdAt: '2026-09-20T00:00:00.000Z',
    startedAt: null,
    finishedAt: null,
    revision: 0,
    tree: createRunTree(definition),
    artifacts: [],
    ...overrides,
  };
}

test('parseLastEventId accepts missing and non-negative decimals only', () => {
  assert.equal(parseLastEventId(undefined), undefined);
  assert.equal(parseLastEventId(''), undefined);
  assert.equal(parseLastEventId('0'), 0);
  assert.equal(parseLastEventId('12'), 12);
  assert.throws(() => parseLastEventId('-1'), /invalid Last-Event-ID/);
  assert.throws(() => parseLastEventId('01'), /invalid Last-Event-ID/);
  assert.throws(() => parseLastEventId('1.5'), /invalid Last-Event-ID/);
  assert.throws(() => parseLastEventId('abc'), /invalid Last-Event-ID/);
});

test('toSseRun strips LiveRun definition and rejects invalid public runs', () => {
  const publicRun = toSseRun({ ...run(), definition });
  assert.equal(publicRun?.id, 'run-1');
  assert.equal('definition' in (publicRun ?? {}), false);
  assert.equal(toSseRun({ ...run(), status: 'failed' }), undefined);
});

test('hub does not read unwatched run trees before subscribing or after disconnecting', () => {
  const hub = createRunWatchHub(60_000);
  const unwatched = run();
  Object.defineProperty(unwatched, 'tree', {
    get: () => assert.fail('unwatched tree must not be read'),
    enumerable: true,
  });
  hub.publish(unwatched);
  const other = subscribe(hub, run({ id: 'other' }));
  hub.publish(unwatched);
  const current = subscribe(hub, run());
  current.req.emit('close');
  hub.publish(unwatched);
  other.req.emit('close');
});

test('hub publishes complete validated LiveRun snapshots through final and canceled revisions', () => {
  for (const status of ['passed', 'failed', 'canceled'] as const) {
    const hub = createRunWatchHub(60_000);
    const current = subscribe(hub, run());
    hub.publish({ ...run({ status: 'failed' }), definition });
    assert.equal(current.chunks.length, 2);
    const snapshot = run({
      status,
      revision: 2,
      startedAt: run().createdAt,
      finishedAt: run().createdAt,
      ...(status === 'failed' ? { error: 'leaf failed' } : {}),
    });
    if (status === 'canceled') {
      hub.publish({ ...run({ status: 'canceling', startedAt: run().createdAt, revision: 1 }), definition });
      assert.match(current.chunks[2]!, /id: 1\nevent: run\ndata: /);
      assert.equal(JSON.parse(current.chunks[2]!.split('data: ')[1]!).status, 'canceling');
    }
    hub.publish({ ...snapshot, definition });
    const frame = current.chunks.at(-1)!;
    assert.match(frame, /^id: 2\nevent: run\ndata: /);
    assert.deepEqual(JSON.parse(frame.split('data: ')[1]!), snapshot);
    current.req.emit('close');
  }
});

test('hub writes the current run then later revisions to every subscriber', () => {
  const hub = createRunWatchHub(60_000);
  const first = subscribe(hub, run());
  const second = subscribe(hub, run());
  assert.equal(first.chunks.length, 2);
  assert.equal(second.chunks.length, 2);
  assert.match(first.chunks[0]!, /^: connected\n\n$/);
  assert.match(first.chunks[1]!, /id: 0\nevent: run\ndata: /);
  hub.publish(run({ status: 'running', startedAt: run().createdAt, revision: 1 }));
  assert.equal(first.chunks.length, 3);
  assert.equal(second.chunks.length, 3);
  assert.match(first.chunks[2]!, /id: 1\nevent: run\ndata: /);
  first.req.emit('close');
  hub.publish(run({ revision: 2, status: 'running', startedAt: run().createdAt }));
  assert.equal(first.chunks.length, 3);
  assert.equal(second.chunks.length, 4);
});

test('hub skips the first frame when Last-Event-ID already matches', () => {
  const hub = createRunWatchHub(60_000);
  const current = subscribe(hub, run({ revision: 3, status: 'running', startedAt: run().createdAt }), 3);
  assert.equal(current.chunks.length, 1);
  assert.match(current.chunks[0]!, /^: connected\n\n$/);
  hub.publish(run({ revision: 4, status: 'running', startedAt: run().createdAt }));
  assert.equal(current.chunks.length, 2);
  assert.match(current.chunks[1]!, /id: 4\n/);
});

function subscribe(hub: ReturnType<typeof createRunWatchHub>, snapshot: Run, lastEventId?: number) {
  const chunks: string[] = [];
  const req = new EventEmitter();
  const res = new EventEmitter() as EventEmitter & {
    writeHead: (...args: unknown[]) => void;
    write: (chunk: string) => boolean;
    end: () => void;
    flushHeaders: () => void;
    socket: { setNoDelay: () => void; uncork: () => void };
  };
  res.writeHead = () => undefined;
  res.flushHeaders = () => undefined;
  res.socket = { setNoDelay: () => undefined, uncork: () => undefined };
  res.write = (chunk: string) => {
    chunks.push(chunk);
    return true;
  };
  res.end = () => undefined;
  hub.subscribe(snapshot, req as never, res as never, lastEventId);
  return { chunks, req, res };
}
