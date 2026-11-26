import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { createRunTree, findRunNode, stripRunTree } from '@tp/contract';
import type { CaseDefinition, Run, RunNode } from '@tp/contract';

import {
  advanceSelectedRunSnapshot,
  countRunNodeStatuses,
  defaultExpandedRunId,
  elapsedRunMs,
  formatDuration,
  formatJson,
  mergeIncomingRuns,
  mergeRuns,
  preferNewerRun,
  runDurationMs,
  runTreeFromRun,
  selectRunId,
  visibleRunsWithSelectedSnapshot,
  type SelectedRunCache,
} from '../src/domain/run-progress.ts';
import { artifactKind, runArtifactItems } from '../src/domain/run-artifacts.ts';
import { createRunNodePresentation } from '../src/features/RunTreeView.tsx';

const definition: CaseDefinition = {
  main: 'Main',
  trees: {
    Main: {
      type: 'Sequence',
      children: [
        {
          type: 'Action',
          capability: 'demo.move',
          adapter: 'demo',
          actor: 'robot-1',
          ports: { speed: { literal: 2 } },
        },
        { type: 'Condition', capability: 'demo.check', adapter: 'demo', actor: 'robot', ports: {} },
      ],
    },
  },
  sessions: [
    { adapter: 'demo', actor: 'robot-1', ports: {} },
    { adapter: 'demo', actor: 'robot', ports: {} },
  ],
};

function active(overrides: Partial<Run> & Pick<Run, 'id'>): Run {
  return {
    id: overrides.id,
    batchId: 'batch-1',
    caseId: 'case-1',
    createdAt: '2026-09-10T00:00:00.000Z',
    startedAt: null,
    finishedAt: null,
    status: 'queued',
    revision: 0,
    tree: createRunTree(definition),
    artifacts: [],
    ...overrides,
  };
}

function finished(overrides: Partial<Run> & Pick<Run, 'id'>): Run {
  return {
    id: overrides.id,
    batchId: 'batch-1',
    caseId: 'case-1',
    createdAt: '2026-09-10T00:00:00.000Z',
    startedAt: '2026-09-10T00:00:01.000Z',
    finishedAt: '2026-09-10T00:00:02.000Z',
    status: 'passed',
    revision: 0,
    tree: createRunTree(definition),
    artifacts: [],
    ...overrides,
  };
}

test('list snapshots cannot overwrite a newer watched revision', () => {
  const watched = active({ id: 'live', status: 'running', revision: 4 });
  const stale = active({ id: 'live', status: 'queued', revision: 1 });
  assert.equal(preferNewerRun(watched, stale).revision, 4);
  assert.deepEqual(mergeIncomingRuns([watched], [stale, active({ id: 'other', revision: 0 })]), [
    watched,
    active({ id: 'other', revision: 0 }),
  ]);
  const cached = advanceSelectedRunSnapshot(mergeRuns([stale]), 'live', {
    snapshot: mergeRuns([watched])[0]!,
    missingSuccessfulPolls: 0,
  });
  assert.equal(cached.cache?.snapshot.run.revision, 4);
});

test('mergeRuns de-duplicates by id with later items winning and sorts active before history', () => {
  const duplicateActive = active({ id: 'same', status: 'running', createdAt: '2026-09-10T00:09:00.000Z' });
  const duplicateFinished = finished({ id: 'same', status: 'failed', finishedAt: '2026-09-10T00:10:00.000Z' });
  const runs = mergeRuns([
    active({ id: 'queued-new', status: 'queued', createdAt: '2026-09-10T00:12:00.000Z' }),
    active({
      id: 'running-old',
      status: 'running',
      createdAt: '2026-09-10T00:01:00.000Z',
      startedAt: '2026-09-10T00:03:00.000Z',
    }),
    active({
      id: 'running-new',
      status: 'running',
      createdAt: '2026-09-10T00:20:00.000Z',
      startedAt: '2026-09-10T00:11:00.000Z',
    }),
    duplicateActive,
    finished({ id: 'history-old', finishedAt: '2026-09-10T00:03:00.000Z' }),
    finished({ id: 'history-new', finishedAt: '2026-09-10T00:04:00.000Z' }),
    duplicateFinished,
  ]);

  assert.deepEqual(
    runs.map((item) => item.run.id),
    ['queued-new', 'running-new', 'running-old', 'same', 'history-new', 'history-old'],
  );
  assert.equal(runs.filter((item) => item.run.id === 'same').length, 1);
  assert.equal(runs[3]?.kind, 'finished');
  assert.strictEqual(runs[3]?.run, duplicateFinished);
  assert.deepEqual(mergeRuns([duplicateActive, duplicateFinished]), mergeRuns([duplicateActive, duplicateFinished]));
});

test('selectRunId preserves an existing selection and otherwise picks only the newest active run', () => {
  const runs = mergeRuns([
    active({ id: 'queued', status: 'queued', createdAt: '2026-09-10T00:02:00.000Z' }),
    active({ id: 'running', status: 'running', createdAt: '2026-09-10T00:01:00.000Z' }),
    finished({ id: 'history' }),
  ]);

  assert.equal(selectRunId('history', runs), 'history');
  assert.equal(selectRunId('missing', runs), 'queued');
  assert.equal(selectRunId('', runs), 'queued');
  assert.equal(selectRunId('missing', mergeRuns([finished({ id: 'history' })])), '');
});

test('default expanded state remains automatic until an active run exists', () => {
  const noRuns = mergeRuns([]);
  const activeRuns = mergeRuns([active({ id: 'latest', createdAt: '2026-09-10T00:02:00.000Z' })]);

  assert.equal(defaultExpandedRunId(null, noRuns), null);
  assert.equal(defaultExpandedRunId(null, activeRuns), 'latest');
  assert.equal(defaultExpandedRunId('', activeRuns), '');
  assert.equal(defaultExpandedRunId(null, noRuns), null, 'expired selection with no active returns to automatic state');
});

test('runTreeFromRun reads only run.tree', () => {
  const tree = createRunTree(definition);
  findRunNode(tree, '').status = 'running';
  findRunNode(tree, '').attempts = [
    {
      attempt: 1,
      status: 'running',
      startedAt: '2026-09-10T00:00:00.000Z',
      finishedAt: null,
    },
  ];
  const activeRun = active({ id: 'active', tree, revision: 1 });
  const historicalRun = finished({ id: 'finished', tree, revision: 1 });

  const activeResult = runTreeFromRun(activeRun);
  const finishedResult = runTreeFromRun(historicalRun);

  assert.deepEqual(activeResult.graphDefinition, stripRunTree(tree));
  assert.deepEqual(finishedResult.graphDefinition, stripRunTree(tree));
  assert.deepEqual(activeResult.tree, tree);
  assert.deepEqual(finishedResult.tree, tree);
  assert.strictEqual(activeResult.tree, tree);
  assert.strictEqual(finishedResult.tree, tree);
  assert.equal(activeResult.revision, 1);
  assert.equal(finishedResult.revision, 1);
  assert.equal(findRunNode(tree, '').status, 'running');
});

test('edited Case still draws old run', () => {
  const changed: CaseDefinition = {
    main: 'Main',
    trees: {
      Main: {
        type: 'Fallback',
        children: [{ type: 'Action', capability: 'other.act', adapter: 'demo', actor: 'robot', ports: {} }],
      },
    },
    sessions: [{ adapter: 'demo', actor: 'robot', ports: {} }],
  };
  const run = finished({ id: 'edited-case', tree: createRunTree(definition) });
  const result = runTreeFromRun(run);

  assert.deepEqual(stripRunTree(run.tree).trees, definition.trees);
  assert.deepEqual(result.graphDefinition.trees, definition.trees);
  assert.notDeepEqual(stripRunTree(run.tree).trees, changed.trees);
});

test('runTreeFromRun graph matches the definition used at create', () => {
  const tree = createRunTree(definition);
  const run = finished({ id: 'roundtrip', tree });
  assert.deepEqual(runTreeFromRun(run).graphDefinition.trees, definition.trees);
});

test('runTreeFromRun accepts an Inverter definition without numeric wrapper fields', () => {
  const inverter: CaseDefinition = {
    main: 'Main',
    trees: {
      Main: {
        type: 'Inverter',
        child: { type: 'Action', capability: 'demo.move', adapter: 'demo', actor: 'robot', ports: {} },
      },
    },
    sessions: [{ adapter: 'demo', actor: 'robot', ports: {} }],
  };
  const run = active({
    id: 'invert',
    tree: createRunTree(inverter),
  });
  const result = runTreeFromRun(run);

  assert.deepEqual(result.graphDefinition.trees, inverter.trees);
  assert.equal(findRunNode(result.tree, '').type, 'Inverter');
  assert.equal(findRunNode(result.tree, 'child').type, 'Action');
});

test('runTreeFromRun rejects illegal trees', () => {
  const broken = finished({
    id: 'broken',
    tree: {
      main: 'Main',
      trees: {
        Main: { type: 'Sequence', status: 'pending', attempts: [] } as RunNode,
      },
    },
  });
  const missingMain = finished({
    id: 'missing',
    status: 'canceled',
    tree: { main: 'Main', trees: {} },
  });

  assert.throws(() => runTreeFromRun(broken));
  assert.throws(() => findRunNode(missingMain.tree, ''));
  assert.throws(() => findRunNode(createRunTree(definition), 'children.9'));
});

test('selected run cache bridges exactly one successful missing poll before the finished run arrives', () => {
  const activeItem = mergeRuns([active({ id: 'transition', status: 'running' })])[0]!;
  const finishedItem = mergeRuns([finished({ id: 'transition', status: 'passed' })])[0]!;

  const present = advanceSelectedRunSnapshot([activeItem], 'transition', null);
  assert.deepEqual(present.cache, { snapshot: activeItem, missingSuccessfulPolls: 0 });
  const missing = advanceSelectedRunSnapshot([], 'transition', present.cache);
  assert.deepEqual(missing.cache, { snapshot: activeItem, missingSuccessfulPolls: 1 });
  assert.deepEqual(visibleRunsWithSelectedSnapshot([], 'transition', missing.cache), [activeItem]);
  const completed = advanceSelectedRunSnapshot([finishedItem], 'transition', missing.cache);
  assert.deepEqual(completed.cache, { snapshot: finishedItem, missingSuccessfulPolls: 0 });
  assert.equal(completed.expired, false);
});

test('selected run cache expires on the second successful missing poll', () => {
  const activeItem = mergeRuns([active({ id: 'transition', status: 'running' })])[0]!;
  let cache: SelectedRunCache | null = { snapshot: activeItem, missingSuccessfulPolls: 0 };

  const firstMissing = advanceSelectedRunSnapshot([], 'transition', cache);
  cache = firstMissing.cache;
  assert.equal(firstMissing.expired, false);
  assert.deepEqual(visibleRunsWithSelectedSnapshot([], 'transition', cache), [activeItem]);

  const secondMissing = advanceSelectedRunSnapshot([], 'transition', cache);
  assert.equal(secondMissing.expired, true);
  assert.equal(secondMissing.cache, null);
  assert.deepEqual(visibleRunsWithSelectedSnapshot([], 'transition', secondMissing.cache), []);
});

test('node presentation hides a single execution and labels Retry as current/max times', () => {
  const retryDefinition: CaseDefinition = {
    main: 'Main',
    trees: {
      Main: {
        type: 'RetryUntilSuccessful',
        num_attempts: 3,
        child: {
          type: 'Sequence',
          children: [{ type: 'Action', capability: 'demo.move', adapter: 'demo', actor: 'robot' }],
        },
      },
    },
    sessions: [{ adapter: 'demo', actor: 'robot', ports: {} }],
  };
  const tree = createRunTree(retryDefinition);
  const retryRoot = retryDefinition.trees.Main;
  const pendingPresentation = createRunNodePresentation(tree, [], Date.parse('2026-09-10T00:00:04.000Z'));
  assert.equal(pendingPresentation('', retryRoot).detail, '0/3 次');
  assert.equal(pendingPresentation('', retryRoot).attempt, undefined);
  const retryNode = findRunNode(tree, '');
  retryNode.status = 'running';
  retryNode.attempts = [{ attempt: 1, status: 'running', startedAt: '2026-09-10T00:00:00.000Z', finishedAt: null }];
  const firstSequence = findRunNode(tree, 'child');
  firstSequence.status = 'running';
  firstSequence.attempts = [{ attempt: 1, status: 'running', startedAt: '2026-09-10T00:00:00.000Z', finishedAt: null }];
  const firstLeaf = findRunNode(tree, 'child.children.0');
  firstLeaf.status = 'running';
  firstLeaf.attempts = [{ attempt: 1, status: 'running', startedAt: '2026-09-10T00:00:00.000Z', finishedAt: null }];
  const firstPass = createRunNodePresentation(tree, [], Date.parse('2026-09-10T00:00:04.000Z'));
  assert.equal(firstPass('', retryRoot).detail, '1/3 次');
  assert.equal(firstPass('', retryRoot).attempt, undefined);
  assert.equal(firstPass('child.children.0', retryRoot.child.children[0]!).attempt, undefined);
  assert.equal(firstPass('', retryRoot).pathClass, 'running-path');
  assert.equal(firstPass('child', retryRoot.child).pathClass, 'running-path');

  const retriedSequence = findRunNode(tree, 'child');
  retriedSequence.status = 'running';
  retriedSequence.attempts = [
    { attempt: 1, status: 'failed', startedAt: '2026-09-10T00:00:00.000Z', finishedAt: '2026-09-10T00:00:01.000Z' },
    { attempt: 2, status: 'running', startedAt: '2026-09-10T00:00:02.000Z', finishedAt: null },
  ];
  const retriedLeaf = findRunNode(tree, 'child.children.0');
  retriedLeaf.status = 'passed';
  retriedLeaf.attempts = [
    { attempt: 1, status: 'failed', startedAt: '2026-09-10T00:00:00.000Z', finishedAt: '2026-09-10T00:00:01.000Z' },
    { attempt: 2, status: 'passed', startedAt: '2026-09-10T00:00:02.000Z', finishedAt: '2026-09-10T00:00:03.000Z' },
  ];

  const presentation = createRunNodePresentation(tree, [], Date.parse('2026-09-10T00:00:04.000Z'));
  assert.equal(presentation('', retryRoot).detail, '2/3 次');
  assert.equal(presentation('', retryRoot).attempt, undefined);
  assert.equal(presentation('child', retryRoot.child).attempt, 2);
  assert.equal(presentation('child.children.0', retryRoot.child.children[0]!).attempt, 2);
});

test('status counts and elapsed calculations are complete, immutable, and never negative', () => {
  const tree = createRunTree(definition);
  findRunNode(tree, '').status = 'running';
  findRunNode(tree, 'children.0').status = 'passed';
  findRunNode(tree, 'children.1').status = 'failed';
  const canceled = createRunTree({
    main: 'Main',
    trees: {
      Main: { type: 'Condition', capability: 'demo.check', adapter: 'demo', actor: 'robot', ports: {} },
    },
    sessions: [{ adapter: 'demo', actor: 'robot', ports: {} }],
  });
  findRunNode(canceled, '').status = 'canceled';
  const before = structuredClone(tree);

  assert.deepEqual(countRunNodeStatuses(tree), {
    pending: 0,
    running: 1,
    passed: 1,
    failed: 1,
    skipped: 0,
    canceled: 0,
  });
  assert.deepEqual(countRunNodeStatuses(canceled), {
    pending: 0,
    running: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    canceled: 1,
  });
  assert.deepEqual(tree, before);
  assert.equal(
    elapsedRunMs(active({ id: 'a', startedAt: '2026-09-10T00:00:02.000Z' }), Date.parse('2026-09-10T00:00:05.250Z')),
    3250,
  );
  assert.equal(elapsedRunMs(active({ id: 'future', startedAt: '2999-01-01T00:00:00.000Z' }), 0), 0);
  assert.equal(elapsedRunMs(active({ id: 'invalid', startedAt: 'invalid' }), Date.now()), 0);
  assert.equal(runDurationMs(finished({ id: 'r' })), 1000);
  assert.equal(runDurationMs(finished({ id: 'future', startedAt: '2026-09-10T00:00:03.000Z' })), 0);
  assert.equal(runDurationMs(finished({ id: 'invalid', startedAt: 'invalid' })), 0);
});

test('run artifacts become named links', () => {
  const run = {
    id: 'run-1',
    artifacts: [{ id: 'a1', name: 'robot 录屏', mediaType: 'video/mp4' }],
  };
  assert.deepEqual(runArtifactItems(run), [
    { id: 'a1', name: 'robot 录屏', href: '/api/runs/run-1/artifacts/a1', mediaType: 'video/mp4' },
  ]);
  assert.equal(artifactKind('video/mp4'), 'video');
  assert.equal(artifactKind('image/png'), 'image');
  assert.equal(artifactKind('text/plain'), 'text');
  assert.equal(artifactKind('application/zip'), 'file');
});

test('duration and JSON display use stable readable formats', () => {
  assert.equal(formatDuration(0), '0秒');
  assert.equal(formatDuration(999), '<1秒');
  assert.equal(formatDuration(65_000), '1分 5秒');
  assert.equal(formatDuration(3_661_000), '1时 1分 1秒');
  assert.equal(formatDuration(Number.NaN), '0秒');
  assert.equal(formatJson({ nested: { ok: true } }), '{\n  "nested": {\n    "ok": true\n  }\n}');
});

test('RunTreeView uses the shared run graph, capability registry, accessible statuses, and text-only JSON', async () => {
  const source = await readFile('src/features/RunTreeView.tsx', 'utf8');
  const graph = await readFile('src/features/BehaviorTreeGraph.tsx', 'utf8');

  assert.match(source, /BehaviorTreeGraph/);
  assert.match(source, /mode="run"/);
  assert.match(source, /fitViewKey=\{run\.id\}/);
  assert.match(source, /capabilities/);
  assert.doesNotMatch(source, /demo/i);
  assert.match(source, /aria-label/);
  assert.match(source, /<pre>/);
  assert.doesNotMatch(source, /dangerouslySetInnerHTML/);
  assert.match(source, /attempts\.map/);
  assert.match(source, /执行记录/);
  assert.match(source, /尚未执行/);
  assert.match(source, /第 \{attempt\.attempt\} 次/);
  assert.doesNotMatch(source, /<h3>Attempts<\/h3>|Attempt \{/);
  assert.match(graph, /第 \$\{presentation\.attempt\} 次/);
  assert.doesNotMatch(graph, /attempt \$\{presentation\.attempt\}/);
  assert.match(source, /<BehaviorTreeGraph/);
  assert.match(source, /stripRunTree\(run\.tree\)|stripRunTree\(/);
  assert.match(source, /findRunNode\(run\.tree/);
});

test('App presents a single non-overlapping Runs poll and expands newly created runs', async () => {
  const source = await readFile('src/App.tsx', 'utf8');
  const runs = await readFile('src/features/RunsPage.tsx', 'utf8');
  const styles = await readFile('src/styles.css', 'utf8');

  assert.match(runs, /Runs List/);
  assert.match(runs, /run-fold/);
  assert.doesNotMatch(runs, /groupRuns/);
  assert.match(source, /listBatches/);
  assert.match(source, /defaultExpandedRunId/);
  assert.doesNotMatch(source, /selectRunId/);
  assert.match(source, /applyRunSelection\(run\.id/);
  assert.match(source, /setTimeout/);
  assert.doesNotMatch(source, /setInterval\(refresh,\s*2000\)/);
  assert.match(source, /connectionWarning/);
  assert.match(runs, /runTreeFromRun\(run\)/);
  assert.match(runs, /产物/);
  assert.match(runs, /run-artifacts/);
  for (const status of ['pending', 'running', 'passed', 'failed', 'skipped', 'canceled']) {
    assert.match(styles, new RegExp(`status-${status}`));
  }
  assert.match(styles, /prefers-reduced-motion/);
});
