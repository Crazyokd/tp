import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apiErrorSchema, httpStatusForCode } from '../src/http-error.ts';
import { pageQuerySchema, paginate, pageSchema } from '../src/http-page.ts';
import { z } from 'zod';
import { httpMetricsSchema, operations } from '../src/http-operations.ts';
import {
  apiPaths,
  adapterPath,
  casePath,
  groupPath,
  runPath,
  runEventsPath,
  runCancelPath,
  runArtifactPath,
  workerPath,
} from '../src/http.ts';

test('error code maps to status', () => {
  assert.equal(httpStatusForCode('not_found'), 404);
  assert.equal(httpStatusForCode('invalid'), 400);
  assert.equal(httpStatusForCode('conflict'), 409);
  assert.equal(httpStatusForCode('forbidden'), 403);
  assert.equal(apiErrorSchema.parse({ code: 'not_found', message: 'x' }).code, 'not_found');
  assert.throws(() => apiErrorSchema.parse({ error: 'x' }));
});

test('page query: omitted is unpaged; one side is invalid', () => {
  const unpaged = pageQuerySchema.parse({});
  assert.deepEqual(unpaged, {});
  assert.equal(unpaged.limit, undefined);
  assert.equal(unpaged.offset, undefined);
  assert.deepEqual(pageQuerySchema.parse({ limit: '10', offset: '0' }), { limit: 10, offset: 0 });
  assert.throws(() => pageQuerySchema.parse({ limit: '10' }));
  assert.throws(() => pageQuerySchema.parse({ offset: '0' }));
});

test('paginate slices after the caller filtered', () => {
  const items = [1, 2, 3];
  assert.deepEqual(paginate(items, {}), { items, total: 3 });
  assert.deepEqual(paginate(items, { limit: 1, offset: 2 }), { items: [3], total: 3 });
  assert.deepEqual(paginate(items, { limit: 1, offset: 9 }), { items: [], total: 3 });
  pageSchema(z.number()).parse({ items: [1], total: 1 });
});

test('public paths', () => {
  assert.equal(apiPaths.adapters, '/api/adapters');
  assert.equal(apiPaths.cases, '/api/cases');
  assert.equal(apiPaths.groups, '/api/groups');
  assert.equal(groupPath('a'), '/api/groups/a');
  assert.equal(apiPaths.runs, '/api/runs');
  assert.equal(apiPaths.workers, '/api/workers');
  assert.equal(apiPaths.metrics, '/api/metrics');
  assert.equal(adapterPath('demo'), '/api/adapters/demo');
  assert.equal(casePath('a'), '/api/cases/a');
  assert.equal(runPath('a'), '/api/runs/a');
  assert.equal(runEventsPath('a'), '/api/runs/a/events');
  assert.equal(runCancelPath('a'), '/api/runs/a/cancel');
  assert.ok(operations.some((item) => item.id === 'watchRun' && item.path === '/api/runs/:id/events'));
  assert.equal(
    operations.some((item) => item.id === 'getRun'),
    false,
  );
  assert.equal(runArtifactPath('r1', 'a1'), '/api/runs/r1/artifacts/a1');
  assert.ok(
    operations.some((item) => item.id === 'getRunArtifact' && item.path === '/api/runs/:id/artifacts/:artifactId'),
  );
  assert.equal(workerPath('1'), '/api/workers/1');
  assert.deepEqual(Object.keys(apiPaths).sort(), [
    'adapters',
    'batches',
    'cases',
    'groups',
    'metrics',
    'runs',
    'workers',
  ]);
});

test('metrics DTO is collect snapshot wrapped in instruments', () => {
  const parsed = httpMetricsSchema.parse({
    instruments: [
      {
        kind: 'counter',
        name: 'cases_total',
        help: 'Case mutations',
        series: [{ labels: { action: 'created' }, value: 1 }],
      },
      { kind: 'gauge', name: 'run_queue_depth', series: [{ labels: {}, value: 0 }] },
      {
        kind: 'histogram',
        name: 'run_seconds',
        series: [
          {
            labels: { status: 'passed' },
            buckets: [
              { le: 0.1, count: 1 },
              { le: '+Inf', count: 1 },
            ],
            sum: 0.05,
            count: 1,
          },
        ],
      },
    ],
  });
  assert.equal(parsed.instruments[1]?.kind, 'gauge');
  assert.equal(
    parsed.instruments[2] && 'series' in parsed.instruments[2]
      ? parsed.instruments[2].series[0]?.buckets.at(-1)?.le
      : undefined,
    '+Inf',
  );
  assert.throws(() => httpMetricsSchema.parse({ instruments: [{ kind: 'counter', name: 'x' }] }));
  assert.throws(() => httpMetricsSchema.parse({ items: [] }));
});
