export type Labels = Record<string, string>;

export type Counter = {
  inc(delta?: number, labels?: Labels): void;
};

export type Gauge = {
  set(value: number, labels?: Labels): void;
  inc(delta?: number, labels?: Labels): void;
  dec(delta?: number, labels?: Labels): void;
};

export type Histogram = {
  observe(value: number, labels?: Labels): void;
};

export type InstrumentOptions = {
  help?: string;
};

export type HistogramOptions = InstrumentOptions & {
  buckets: number[];
};

export type CounterSnapshot = {
  kind: 'counter';
  name: string;
  help?: string;
  series: Array<{ labels: Labels; value: number }>;
};

export type GaugeSnapshot = {
  kind: 'gauge';
  name: string;
  help?: string;
  series: Array<{ labels: Labels; value: number }>;
};

export type HistogramSnapshot = {
  kind: 'histogram';
  name: string;
  help?: string;
  series: Array<{
    labels: Labels;
    buckets: Array<{ le: number | '+Inf'; count: number }>;
    sum: number;
    count: number;
  }>;
};

export type InstrumentSnapshot = CounterSnapshot | GaugeSnapshot | HistogramSnapshot;

export type Metrics = {
  counter(name: string, options?: InstrumentOptions): Counter;
  gauge(name: string, options?: InstrumentOptions): Gauge;
  histogram(name: string, options: HistogramOptions): Histogram;
  collect(): InstrumentSnapshot[];
};

const NAME_RE = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL_KEY_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const KINDS = ['counter', 'gauge', 'histogram'] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireFinite(value: unknown, message: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(message);
  return value;
}

function requireName(name: unknown): string {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new Error('metric name must be a non-empty string');
  }
  const trimmed = name.trim();
  if (!NAME_RE.test(trimmed)) throw new Error('invalid metric name');
  return trimmed;
}

function requireHelp(options: Record<string, unknown>): string | undefined {
  if (!Object.hasOwn(options, 'help')) return undefined;
  if (typeof options.help !== 'string' || options.help.trim() === '') {
    throw new Error('metric help must be a non-empty string');
  }
  return options.help.trim();
}

function requireKnownKeys(options: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(options)) {
    if (!allowed.includes(key)) throw new Error(`unknown metric option ${key}`);
  }
}

function requireInstrumentOptions(options: unknown, allowed: readonly string[]): { help?: string } {
  if (options === undefined) return {};
  if (!isPlainObject(options)) throw new Error('metric options must be an object');
  requireKnownKeys(options, allowed);
  const help = requireHelp(options);
  return help === undefined ? {} : { help };
}

function requireBuckets(options: Record<string, unknown>): number[] {
  if (!Object.hasOwn(options, 'buckets') || !Array.isArray(options.buckets) || options.buckets.length === 0) {
    throw new Error('histogram buckets must be a non-empty array');
  }
  const buckets = options.buckets.map((bound, index) => {
    const value = requireFinite(bound, 'histogram buckets must be finite numbers');
    if (index > 0 && value <= (options.buckets as number[])[index - 1]!) {
      throw new Error('histogram buckets must be strictly increasing');
    }
    return value;
  });
  return buckets;
}

function requireLabels(labels: unknown): Labels {
  if (labels === undefined) return {};
  if (!isPlainObject(labels)) throw new Error('metric labels must be an object');
  const resolved: Labels = {};
  for (const [key, value] of Object.entries(labels)) {
    if (!LABEL_KEY_RE.test(key) || key.startsWith('__')) throw new Error('invalid metric label name');
    if (typeof value !== 'string') throw new Error('metric label values must be strings');
    resolved[key] = value;
  }
  return resolved;
}

function labelKey(keys: string[], labels: Labels): string {
  return keys.map((key) => `${key}=${labels[key]}`).join('\0');
}

function cloneLabels(keys: string[], labels: Labels): Labels {
  const copy: Labels = {};
  for (const key of keys) copy[key] = labels[key]!;
  return copy;
}

type SeriesMap<T> = { keys: string[] | undefined; items: Map<string, T> };

function seriesFor<T>(series: SeriesMap<T>, labels: unknown, create: () => T): T {
  const resolved = requireLabels(labels);
  const incoming = Object.keys(resolved);
  if (series.keys === undefined) {
    series.keys = incoming;
  } else if (incoming.length !== series.keys.length || incoming.some((key) => !series.keys!.includes(key))) {
    throw new Error('metric label names must match the first observation');
  }
  const key = labelKey(series.keys, resolved);
  const existing = series.items.get(key);
  if (existing) return existing;
  const created = create();
  series.items.set(key, created);
  return created;
}

function snapshotBase(name: string, help: string | undefined): { name: string; help?: string } {
  return help === undefined ? { name } : { name, help };
}

type CounterPoint = { labels: Labels; value: number };
type GaugePoint = { labels: Labels; value: number };
type HistogramPoint = {
  labels: Labels;
  counts: number[];
  inf: number;
  sum: number;
  count: number;
};

type Instrument =
  | { kind: 'counter'; name: string; help?: string; series: SeriesMap<CounterPoint> }
  | { kind: 'gauge'; name: string; help?: string; series: SeriesMap<GaugePoint> }
  | {
      kind: 'histogram';
      name: string;
      help?: string;
      buckets: number[];
      series: SeriesMap<HistogramPoint>;
    };

function emptySeries<T>(): SeriesMap<T> {
  return { keys: undefined, items: new Map() };
}

export function createMetrics(): Metrics {
  const instruments: Instrument[] = [];
  const names = new Set<string>();

  const register = (name: string): string => {
    const resolved = requireName(name);
    if (names.has(resolved)) throw new Error(`metric already registered: ${resolved}`);
    names.add(resolved);
    return resolved;
  };

  const counter = (name: string, options?: InstrumentOptions): Counter => {
    const { help } = requireInstrumentOptions(options, ['help']);
    const resolved = register(name);
    const instrument: Extract<Instrument, { kind: 'counter' }> = {
      kind: 'counter',
      name: resolved,
      help,
      series: emptySeries(),
    };
    instruments.push(instrument);
    return {
      inc(delta?: number, labels?: Labels) {
        const amount = delta === undefined ? 1 : requireFinite(delta, 'counter increment must be finite');
        if (amount < 0) throw new Error('counter increment cannot be negative');
        const point = seriesFor(instrument.series, labels, () => ({
          labels: cloneLabels(instrument.series.keys!, requireLabels(labels)),
          value: 0,
        }));
        point.value += amount;
      },
    };
  };

  const gauge = (name: string, options?: InstrumentOptions): Gauge => {
    const { help } = requireInstrumentOptions(options, ['help']);
    const resolved = register(name);
    const instrument: Extract<Instrument, { kind: 'gauge' }> = {
      kind: 'gauge',
      name: resolved,
      help,
      series: emptySeries(),
    };
    instruments.push(instrument);
    const point = (labels?: Labels) =>
      seriesFor(instrument.series, labels, () => ({
        labels: cloneLabels(instrument.series.keys!, requireLabels(labels)),
        value: 0,
      }));
    return {
      set(value: number, labels?: Labels) {
        const amount = requireFinite(value, 'gauge value must be finite');
        point(labels).value = amount;
      },
      inc(delta?: number, labels?: Labels) {
        const amount = delta === undefined ? 1 : requireFinite(delta, 'gauge increment must be finite');
        point(labels).value += amount;
      },
      dec(delta?: number, labels?: Labels) {
        const amount = delta === undefined ? 1 : requireFinite(delta, 'gauge decrement must be finite');
        if (amount < 0) throw new Error('gauge decrement cannot be negative');
        point(labels).value -= amount;
      },
    };
  };

  const histogram = (name: string, options: HistogramOptions): Histogram => {
    if (options === undefined || !isPlainObject(options)) {
      throw new Error('histogram options must be an object');
    }
    requireKnownKeys(options, ['help', 'buckets']);
    const help = requireHelp(options);
    const buckets = requireBuckets(options);
    const resolved = register(name);
    const instrument: Extract<Instrument, { kind: 'histogram' }> = {
      kind: 'histogram',
      name: resolved,
      help,
      buckets,
      series: emptySeries(),
    };
    instruments.push(instrument);
    return {
      observe(value: number, labels?: Labels) {
        const amount = requireFinite(value, 'histogram observation must be finite');
        if (amount < 0) throw new Error('histogram observation cannot be negative');
        const point = seriesFor(instrument.series, labels, () => ({
          labels: cloneLabels(instrument.series.keys!, requireLabels(labels)),
          counts: instrument.buckets.map(() => 0),
          inf: 0,
          sum: 0,
          count: 0,
        }));
        for (let i = 0; i < instrument.buckets.length; i += 1) {
          if (amount <= instrument.buckets[i]!) point.counts[i]! += 1;
        }
        point.inf += 1;
        point.sum += amount;
        point.count += 1;
      },
    };
  };

  const collect = (): InstrumentSnapshot[] =>
    instruments.map((instrument) => {
      if (instrument.kind === 'histogram') {
        return {
          kind: 'histogram',
          ...snapshotBase(instrument.name, instrument.help),
          series: [...instrument.series.items.values()].map((point) => ({
            labels: { ...point.labels },
            buckets: [
              ...instrument.buckets.map((le, index) => ({ le, count: point.counts[index]! })),
              { le: '+Inf' as const, count: point.inf },
            ],
            sum: point.sum,
            count: point.count,
          })),
        };
      }
      return {
        kind: instrument.kind,
        ...snapshotBase(instrument.name, instrument.help),
        series: [...instrument.series.items.values()].map((point) => ({
          labels: { ...point.labels },
          value: point.value,
        })),
      };
    });

  return { counter, gauge, histogram, collect };
}

function escapeHelp(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('\n', '\\n');
}

function escapeLabelValue(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('\n', '\\n').replaceAll('"', '\\"');
}

function formatLabels(labels: Labels, extra?: Array<[string, string]>): string {
  const parts = Object.entries(labels).map(([key, value]) => `${key}="${escapeLabelValue(value)}"`);
  if (extra) {
    for (const [key, value] of extra) parts.push(`${key}="${escapeLabelValue(value)}"`);
  }
  if (parts.length === 0) return '';
  return `{${parts.join(',')}}`;
}

function formatLe(le: number | '+Inf'): string {
  return le === '+Inf' ? '+Inf' : String(le);
}

function isLabels(value: unknown): value is Labels {
  if (!isPlainObject(value)) return false;
  return Object.entries(value).every(
    ([key, item]) => LABEL_KEY_RE.test(key) && !key.startsWith('__') && typeof item === 'string',
  );
}

function isSnapshot(value: unknown): value is InstrumentSnapshot[] {
  if (!Array.isArray(value)) return false;
  return value.every((instrument) => {
    if (!isPlainObject(instrument)) return false;
    if (!KINDS.includes(instrument.kind as (typeof KINDS)[number])) return false;
    if (typeof instrument.name !== 'string' || !NAME_RE.test(instrument.name)) return false;
    if (instrument.help !== undefined && typeof instrument.help !== 'string') return false;
    if (!Array.isArray(instrument.series)) return false;
    if (instrument.kind === 'histogram') {
      return instrument.series.every((point) => {
        if (!isPlainObject(point) || !isLabels(point.labels)) return false;
        if (typeof point.sum !== 'number' || typeof point.count !== 'number') return false;
        if (!Array.isArray(point.buckets)) return false;
        return point.buckets.every((bucket) => {
          if (!isPlainObject(bucket) || typeof bucket.count !== 'number') return false;
          return bucket.le === '+Inf' || typeof bucket.le === 'number';
        });
      });
    }
    return instrument.series.every((point) => {
      return isPlainObject(point) && isLabels(point.labels) && typeof point.value === 'number';
    });
  });
}

export function formatPrometheus(snapshot: InstrumentSnapshot[]): string {
  if (!isSnapshot(snapshot)) throw new Error('metrics snapshot must be an array');
  const lines: string[] = [];
  for (const instrument of snapshot) {
    if (instrument.help !== undefined) {
      lines.push(`# HELP ${instrument.name} ${escapeHelp(instrument.help)}`);
    }
    lines.push(`# TYPE ${instrument.name} ${instrument.kind}`);
    if (instrument.kind === 'histogram') {
      for (const point of instrument.series) {
        for (const bucket of point.buckets) {
          lines.push(
            `${instrument.name}_bucket${formatLabels(point.labels, [['le', formatLe(bucket.le)]])} ${bucket.count}`,
          );
        }
        lines.push(`${instrument.name}_sum${formatLabels(point.labels)} ${point.sum}`);
        lines.push(`${instrument.name}_count${formatLabels(point.labels)} ${point.count}`);
      }
      continue;
    }
    for (const point of instrument.series) {
      lines.push(`${instrument.name}${formatLabels(point.labels)} ${point.value}`);
    }
  }
  return `${lines.join('\n')}\n`;
}
