import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRunTree, type Batch, type TestCase } from '@tp/contract';
import { RunsPage } from '../src/features/RunsPage.tsx';
import { CasesPage } from '../src/features/CasesPage.tsx';
import { mergeRuns } from '../src/domain/run-progress.ts';
import { cancelBatch, createBatch, getBatch, listBatches } from '../src/api/client.ts';

const now = '2026-11-18T00:00:00.000Z';
const item: TestCase = {
  id: 'case-1',
  name: 'Readiness',
  description: '',
  createdAt: now,
  updatedAt: now,
  definition: {
    main: 'Main',
    trees: { Main: { type: 'Action', adapter: 'test', actor: 'robot', capability: 'test.pass', ports: {} } },
    sessions: [{ adapter: 'test', actor: 'robot', ports: {} }],
  },
};
const batch: Batch = {
  id: 'batch-native',
  name: 'Nightly readiness',
  description: 'Release gate',
  trigger: { kind: 'ci', pipelineUrl: 'https://ci.example/pipelines/42' },
  selection: { kind: 'group', groupId: 'deleted-group', groupName: 'Original smoke' },
  createdAt: now,
  startedAt: null,
  finishedAt: null,
  status: 'queued',
  counts: { queued: 1, running: 0, canceling: 0, passed: 0, failed: 0, canceled: 0 },
  runs: [
    {
      id: 'run-1',
      batchId: 'batch-native',
      caseId: item.id,
      createdAt: now,
      startedAt: null,
      finishedAt: null,
      status: 'queued',
      revision: 0,
      tree: createRunTree(item.definition),
      artifacts: [],
    },
  ],
};

test('single-member native batches retain a batch heading, server counts, and batch cancellation', () => {
  // A newer watched Run is deliberately different from the polled batch summary.
  const html = renderToStaticMarkup(
    createElement(RunsPage, {
      batches: [batch],
      runs: mergeRuns([{ ...batch.runs[0]!, status: 'running', revision: 2 }]),
      cases: [item],
      capabilities: [],
      expandedRunId: '',
      focusBatchId: batch.id,
      now: Date.parse(now),
      onToggle: () => {},
      onCancel: () => {},
      onCancelBatch: () => {},
    }),
  );
  assert.match(html, /data-testid="run-fold"/);
  assert.match(html, /Nightly readiness/);
  assert.match(html, /Release gate/);
  assert.match(html, /声明来源：ci/);
  assert.match(html, /Original smoke/);
  assert.match(html, /href="https:\/\/ci.example\/pipelines\/42"[^>]*rel="noreferrer noopener"[^>]*target="_blank"/);
  assert.match(html, /batch-native/);
  assert.match(html, /aria-label="批次状态"[^>]*>排队中/);
  assert.match(html, /排队中 1/);
  assert.match(html, /data-testid="cancel-batch"/);
  assert.match(html, /data-testid="cancel-run"/);
  assert.match(html, /执行中/);
});

test('Case selection exposes named native checkboxes and a disabled empty selection launch', () => {
  const html = renderToStaticMarkup(
    createElement(CasesPage, {
      cases: [item],
      onCreate: () => {},
      onEdit: () => {},
      onStartBatch: () => {},
      onRemove: () => {},
    }),
  );
  assert.match(html, /type="checkbox"[^>]*aria-label="选择 Readiness"/);
  assert.match(html, /disabled=""[^>]*>[^<]*创建批次/);
});

test('Batch client uses native routes and strict caseIds or groupId selectors', async () => {
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  const calls: { path: string; init?: RequestInit }[] = [];
  Object.assign(globalThis, { window: { location: { origin: 'http://localhost' } } });
  globalThis.fetch = async (input, init) => {
    const path = String(input);
    calls.push({ path, init });
    return new Response(
      JSON.stringify(path === '/api/batches' && !init?.method ? { items: [batch], total: 1 } : batch),
    );
  };
  try {
    assert.equal((await listBatches()).items[0]?.id, batch.id);
    await getBatch(batch.id);
    await createBatch({
      caseIds: ['case-1', 'case-2'],
      trigger: { kind: 'web' },
      name: 'Readiness run',
      description: 'Check release',
    });
    await createBatch({ groupId: 'group-id', trigger: { kind: 'web' } });
    await cancelBatch(batch.id);
    assert.deepEqual(
      calls.map((call) => call.path),
      ['/api/batches', '/api/batches/batch-native', '/api/batches', '/api/batches', '/api/batches/batch-native/cancel'],
    );
    assert.deepEqual(JSON.parse(String(calls[2]?.init?.body)), {
      caseIds: ['case-1', 'case-2'],
      trigger: { kind: 'web' },
      name: 'Readiness run',
      description: 'Check release',
    });
    assert.deepEqual(JSON.parse(String(calls[3]?.init?.body)), { groupId: 'group-id', trigger: { kind: 'web' } });
    const count = calls.length;
    await assert.rejects(createBatch({ caseIds: ['case-1'] }));
    await assert.rejects(createBatch({ caseIds: ['case-1'], trigger: { kind: 'web' }, selection: { kind: 'cases' } }));
    await assert.rejects(createBatch({ caseIds: [], groupId: 'bad', trigger: { kind: 'web' } }));
    await assert.rejects(createBatch({ caseIds: ['case-1', 'case-1'], trigger: { kind: 'web' } }));
    assert.equal(calls.length, count);
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          items: [{ ...batch, trigger: { kind: 'ci', pipelineUrl: 'javascript:alert(1)' } }],
          total: 1,
        }),
      );
    await assert.rejects(listBatches());
    globalThis.fetch = async () => new Response(JSON.stringify({ items: [{ ...batch, name: undefined }], total: 1 }));
    await assert.rejects(listBatches());
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.window = originalWindow;
  }
});
