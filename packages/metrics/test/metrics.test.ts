import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createMetrics, formatPrometheus } from '../src/index.ts';

test('records unlabeled counter gauge and histogram in registration order', () => {
  const metrics = createMetrics();
  const runs = metrics.counter('runs_total', { help: 'finished runs' });
  const queue = metrics.gauge('queue_depth');
  const duration = metrics.histogram('run_seconds', { buckets: [0.1, 1, 5, 30] });

  runs.inc();
  queue.set(3);
  duration.observe(1.2);

  assert.deepEqual(metrics.collect(), [
    {
      kind: 'counter',
      name: 'runs_total',
      help: 'finished runs',
      series: [{ labels: {}, value: 1 }],
    },
    {
      kind: 'gauge',
      name: 'queue_depth',
      series: [{ labels: {}, value: 3 }],
    },
    {
      kind: 'histogram',
      name: 'run_seconds',
      series: [
        {
          labels: {},
          buckets: [
            { le: 0.1, count: 0 },
            { le: 1, count: 0 },
            { le: 5, count: 1 },
            { le: 30, count: 1 },
            { le: '+Inf', count: 1 },
          ],
          sum: 1.2,
          count: 1,
        },
      ],
    },
  ]);
});

test('omits help when not given and trims name and help', () => {
  const metrics = createMetrics();
  metrics.counter('  jobs_total  ', { help: '  queued jobs  ' }).inc(4);
  const [instrument] = metrics.collect();
  assert.deepEqual(instrument, {
    kind: 'counter',
    name: 'jobs_total',
    help: 'queued jobs',
    series: [{ labels: {}, value: 4 }],
  });
});

test('unobserved instruments appear with empty series', () => {
  const metrics = createMetrics();
  metrics.counter('idle_total');
  assert.deepEqual(metrics.collect(), [{ kind: 'counter', name: 'idle_total', series: [] }]);
});

test('collect returns a snapshot that later writes do not mutate', () => {
  const metrics = createMetrics();
  const runs = metrics.counter('runs_total');
  runs.inc();
  const first = metrics.collect();
  runs.inc();
  assert.deepEqual(first, [{ kind: 'counter', name: 'runs_total', series: [{ labels: {}, value: 1 }] }]);
  assert.deepEqual(metrics.collect(), [{ kind: 'counter', name: 'runs_total', series: [{ labels: {}, value: 2 }] }]);
});

test('locks label key set on the first observation', () => {
  const metrics = createMetrics();
  const labeled = metrics.counter('labeled_total');
  labeled.inc(1, { status: 'passed' });
  labeled.inc(2, { status: 'failed' });
  assert.throws(() => labeled.inc(1, { reason: 'passed' }));
  assert.throws(() => labeled.inc(1, { status: 'passed', extra: 'x' }));
  assert.throws(() => labeled.inc());
  assert.throws(() => labeled.inc(1, {}));

  const unlabeled = metrics.counter('unlabeled_total');
  unlabeled.inc();
  assert.throws(() => unlabeled.inc(1, { status: 'passed' }));

  assert.deepEqual(metrics.collect(), [
    {
      kind: 'counter',
      name: 'labeled_total',
      series: [
        { labels: { status: 'passed' }, value: 1 },
        { labels: { status: 'failed' }, value: 2 },
      ],
    },
    {
      kind: 'counter',
      name: 'unlabeled_total',
      series: [{ labels: {}, value: 1 }],
    },
  ]);
});

test('gauge set inc and dec share one series', () => {
  const metrics = createMetrics();
  const queue = metrics.gauge('queue_depth');
  queue.set(10);
  queue.inc();
  queue.inc(4);
  queue.dec();
  queue.dec(2);
  queue.inc(-1);
  assert.deepEqual(metrics.collect(), [{ kind: 'gauge', name: 'queue_depth', series: [{ labels: {}, value: 11 }] }]);
});

test('histogram accumulates buckets sum and count', () => {
  const metrics = createMetrics();
  const duration = metrics.histogram('run_seconds', { buckets: [0.1, 1, 5] });
  duration.observe(0.1);
  duration.observe(3);
  duration.observe(9);
  assert.deepEqual(metrics.collect()[0], {
    kind: 'histogram',
    name: 'run_seconds',
    series: [
      {
        labels: {},
        buckets: [
          { le: 0.1, count: 1 },
          { le: 1, count: 1 },
          { le: 5, count: 2 },
          { le: '+Inf', count: 3 },
        ],
        sum: 12.1,
        count: 3,
      },
    ],
  });
});

test('rejects illegal names options numbers buckets and labels', () => {
  const metrics = createMetrics();
  assert.throws(() => metrics.counter(''));
  assert.throws(() => metrics.counter('   '));
  assert.throws(() => metrics.counter(1 as unknown as string));
  assert.throws(() => metrics.counter('9bad'));
  assert.throws(() => metrics.counter('bad-name'));
  assert.throws(() => metrics.counter('ok', null as unknown as object));
  assert.throws(() => metrics.counter('ok', [] as unknown as object));
  assert.throws(() => metrics.counter('ok', { help: '' }));
  assert.throws(() => metrics.counter('ok', { help: '   ' }));
  assert.throws(() => metrics.counter('ok', { help: undefined }));
  assert.throws(() => metrics.counter('ok', { labelNames: ['status'] } as object));
  metrics.counter('dup');
  assert.throws(() => metrics.counter('dup'));
  assert.throws(() => metrics.gauge('dup'));

  const runs = metrics.counter('runs_total');
  assert.throws(() => runs.inc(-1));
  assert.throws(() => runs.inc(Number.NaN));
  assert.throws(() => runs.inc(Number.POSITIVE_INFINITY));
  assert.throws(() => runs.inc({ status: 'passed' } as unknown as number));
  assert.throws(() => runs.inc(1, null as unknown as object));
  assert.throws(() => runs.inc(1, [] as unknown as object));
  assert.throws(() => runs.inc(1, { '1bad': 'x' }));
  assert.throws(() => runs.inc(1, { __name: 'x' }));
  assert.throws(() => runs.inc(1, { status: 1 as unknown as string }));

  const queue = metrics.gauge('queue_depth');
  assert.throws(() => queue.set(Number.NaN));
  assert.throws(() => queue.dec(-1));

  assert.throws(() => metrics.histogram('run_seconds', undefined as unknown as { buckets: number[] }));
  assert.throws(() => metrics.histogram('run_seconds', {} as { buckets: number[] }));
  assert.throws(() => metrics.histogram('run_seconds', { buckets: [] }));
  assert.throws(() => metrics.histogram('run_seconds', { buckets: [1, 1] }));
  assert.throws(() => metrics.histogram('run_seconds', { buckets: [2, 1] }));
  assert.throws(() => metrics.histogram('run_seconds', { buckets: [1, Number.POSITIVE_INFINITY] }));
  const duration = metrics.histogram('run_seconds', { buckets: [0.1, 1] });
  assert.throws(() => duration.observe(-0.1));
});

test('formatPrometheus writes type optional help and histogram suffixes', () => {
  const metrics = createMetrics();
  metrics.counter('runs_total', { help: 'finished runs' }).inc(2, { status: 'passed' });
  metrics.gauge('queue_depth').set(3);
  metrics.histogram('run_seconds', { help: 'run duration', buckets: [0.1, 1, 5, 30] }).observe(1.2);

  assert.equal(
    formatPrometheus(metrics.collect()),
    [
      '# HELP runs_total finished runs',
      '# TYPE runs_total counter',
      'runs_total{status="passed"} 2',
      '# TYPE queue_depth gauge',
      'queue_depth 3',
      '# HELP run_seconds run duration',
      '# TYPE run_seconds histogram',
      'run_seconds_bucket{le="0.1"} 0',
      'run_seconds_bucket{le="1"} 0',
      'run_seconds_bucket{le="5"} 1',
      'run_seconds_bucket{le="30"} 1',
      'run_seconds_bucket{le="+Inf"} 1',
      'run_seconds_sum 1.2',
      'run_seconds_count 1',
      '',
    ].join('\n'),
  );
});

test('formatPrometheus escapes help and label values', () => {
  const metrics = createMetrics();
  metrics.counter('jobs_total', { help: 'say "hi"\\\nnext' }).inc(1, { path: 'a="b"\\' });
  assert.equal(
    formatPrometheus(metrics.collect()),
    [
      '# HELP jobs_total say "hi"\\\\\\nnext',
      '# TYPE jobs_total counter',
      'jobs_total{path="a=\\"b\\"\\\\"} 1',
      '',
    ].join('\n'),
  );
});

test('formatPrometheus puts le last and keeps labeled histogram suffixes', () => {
  const metrics = createMetrics();
  metrics.histogram('run_seconds', { buckets: [1] }).observe(2, { status: 'passed' });
  assert.equal(
    formatPrometheus(metrics.collect()),
    [
      '# TYPE run_seconds histogram',
      'run_seconds_bucket{status="passed",le="1"} 0',
      'run_seconds_bucket{status="passed",le="+Inf"} 1',
      'run_seconds_sum{status="passed"} 2',
      'run_seconds_count{status="passed"} 1',
      '',
    ].join('\n'),
  );
});

test('formatPrometheus rejects a non-snapshot', () => {
  assert.throws(() => formatPrometheus(undefined as unknown as []));
  assert.throws(() => formatPrometheus({} as unknown as []));
});
