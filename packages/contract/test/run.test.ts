import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AdapterSessionContext } from '../src/adapter-contract.ts';
import { httpRunSchema } from '../src/http-operations.ts';
import { createRunTree } from '../src/run-tree.ts';
import type { CaseDefinition, LiveRun, Run, RunStatus } from '../src/types.ts';

type AssertTrue<T extends true> = T;
type HasKey<T, K extends string> = K extends keyof T ? true : false;
type LacksKey<T, K extends string> = K extends keyof T ? false : true;

type _LiveRunHasDefinition = AssertTrue<HasKey<LiveRun, 'definition'>>;
type _RunHasRevision = AssertTrue<HasKey<Run, 'revision'>>;
type _RunHasTree = AssertTrue<HasKey<Run, 'tree'>>;
type _RunHasArtifacts = AssertTrue<HasKey<Run, 'artifacts'>>;
type _RunLacksTreeProgress = AssertTrue<LacksKey<Run, 'treeProgress'>>;
type _HttpRunLacksDefinition = AssertTrue<LacksKey<Run, 'definition'>>;
type _CtxHasRoot = AssertTrue<HasKey<AdapterSessionContext, 'resourceRoot'>>;
type _CtxHasRecord = AssertTrue<HasKey<AdapterSessionContext, 'recordArtifact'>>;
type _CtxHasInput = AssertTrue<HasKey<AdapterSessionContext, 'input'>>;

const statuses = [
  'queued',
  'running',
  'canceling',
  'passed',
  'failed',
  'canceled',
] as const satisfies readonly RunStatus[];

const definition: CaseDefinition = {
  main: 'Main',
  trees: {
    Main: {
      type: 'Sequence',
      children: [{ type: 'Action', adapter: 'demo', actor: 'robot', capability: 'go' }],
    },
  },
  sessions: [{ adapter: 'demo', actor: 'robot', ports: {} }],
};

function queuedRun(): Run {
  return {
    id: 'run-1',
    batchId: 'batch-1',
    caseId: 'case-1',
    status: 'queued',
    createdAt: '2026-09-11T00:00:00.000Z',
    startedAt: null,
    finishedAt: null,
    revision: 0,
    tree: createRunTree(definition),
    artifacts: [],
  };
}

test('queued Run requires batchId', () => {
  const { batchId: _batchId, ...withoutBatch } = queuedRun();
  assert.throws(() => httpRunSchema.parse(withoutBatch));
});

test('queued Run parses with empty artifacts', () => {
  const run = queuedRun();
  assert.deepEqual(httpRunSchema.parse(run), run);
  assert.deepEqual(run.artifacts, []);
});

test('Run artifacts reject path and open', () => {
  const run = queuedRun();
  assert.throws(() =>
    httpRunSchema.parse({ ...run, artifacts: [{ id: 'a', name: 'n', mediaType: 'text/plain', path: 'x' }] }),
  );
  assert.throws(() =>
    httpRunSchema.parse({ ...run, artifacts: [{ id: 'a', name: 'n', mediaType: 'text/plain', open: true }] }),
  );
});

test('queued Run parses with tree and revision', () => {
  const run = queuedRun();
  assert.deepEqual(httpRunSchema.parse(run), run);
  assert.equal(run.revision, 0);
  assert.equal(run.tree.trees.Main?.status, 'pending');

  for (const status of statuses) {
    const next = { ...run, status } satisfies Run;
    assert.equal(next.status, status);
  }

  assert.throws(() =>
    httpRunSchema.parse({
      ...run,
      extra: true,
    }),
  );
});

test('failed Run requires a non-empty error', () => {
  const run = queuedRun();
  const failed = {
    ...run,
    status: 'failed',
    startedAt: '2026-09-11T00:00:01.000Z',
    finishedAt: '2026-09-11T00:00:02.000Z',
    error: 'leaf failed',
  } satisfies Run;
  assert.equal(httpRunSchema.parse(failed).error, 'leaf failed');

  assert.throws(() =>
    httpRunSchema.parse({
      ...run,
      status: 'failed',
      startedAt: '2026-09-11T00:00:01.000Z',
      finishedAt: '2026-09-11T00:00:02.000Z',
    }),
  );
  assert.throws(() =>
    httpRunSchema.parse({
      ...run,
      status: 'failed',
      startedAt: '2026-09-11T00:00:01.000Z',
      finishedAt: '2026-09-11T00:00:02.000Z',
      error: '',
    }),
  );
});

test('canceled Run rejects error', () => {
  const run = queuedRun();
  assert.throws(() =>
    httpRunSchema.parse({
      ...run,
      status: 'canceled',
      startedAt: '2026-09-11T00:00:01.000Z',
      finishedAt: '2026-09-11T00:00:02.000Z',
      error: 'canceled',
    }),
  );
});

test('treeProgress is rejected on HTTP Run', () => {
  const run = queuedRun();
  assert.throws(() =>
    httpRunSchema.parse({
      ...run,
      treeProgress: { revision: 0, nodes: [] },
    }),
  );
});

test('LiveRun definition is not on HTTP Run', () => {
  const liveRun = {
    ...queuedRun(),
    status: 'running',
    startedAt: '2026-09-11T00:00:01.000Z',
    definition,
  } satisfies LiveRun;

  assert.equal(liveRun.definition.main, 'Main');
  assert.throws(() => httpRunSchema.parse(liveRun));
});
