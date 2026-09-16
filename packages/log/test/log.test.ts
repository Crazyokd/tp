import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createLogger } from '../src/index.ts';

const ISO_PREFIX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /;

function withLogLevel(value: string | undefined, run: () => void): void {
  const had = Object.hasOwn(process.env, 'LOG_LEVEL');
  const previous = process.env.LOG_LEVEL;
  try {
    if (value === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = value;
    run();
  } finally {
    if (had) process.env.LOG_LEVEL = previous;
    else delete process.env.LOG_LEVEL;
  }
}

function collect(): { lines: string[]; write: (line: string) => void } {
  const lines: string[] = [];
  return { lines, write: (line) => lines.push(line) };
}

test('writes time level name and body without a trailing space on an empty call', () => {
  withLogLevel(undefined, () => {
    const { lines, write } = collect();
    const log = createLogger('  server  ', { write });
    log.info();
    log.info('listening', 3000);
    assert.equal(lines.length, 2);
    assert.match(lines[0]!, ISO_PREFIX);
    assert.equal(lines[0]!.slice(25), 'INFO server');
    assert.match(lines[1]!, ISO_PREFIX);
    assert.equal(lines[1]!.slice(25), 'INFO server listening 3000');
    assert.ok(!lines[0]!.endsWith(' '));
  });
});

test('filters below the resolved minimum level', () => {
  withLogLevel(undefined, () => {
    const { lines, write } = collect();
    const log = createLogger('app', { write });
    log.debug('hidden');
    log.info('shown');
    assert.deepEqual(
      lines.map((line) => line.slice(25)),
      ['INFO app shown'],
    );
  });
});

test('options.level wins over LOG_LEVEL', () => {
  withLogLevel('error', () => {
    const { lines, write } = collect();
    const log = createLogger('app', { level: 'debug', write });
    log.debug('x');
    assert.equal(lines[0]!.slice(25), 'DEBUG app x');
  });
});

test('reads LOG_LEVEL when options omit level', () => {
  withLogLevel('warn', () => {
    const { lines, write } = collect();
    const log = createLogger('app', { write });
    log.info('hidden');
    log.warn('shown');
    assert.deepEqual(
      lines.map((line) => line.slice(25)),
      ['WARN app shown'],
    );
  });
});

test('rejects illegal name level options write and LOG_LEVEL', () => {
  withLogLevel(undefined, () => {
    assert.throws(() => createLogger(''));
    assert.throws(() => createLogger('   '));
    assert.throws(() => createLogger(1 as unknown as string));
    assert.throws(() => createLogger('app', null as unknown as object));
    assert.throws(() => createLogger('app', [] as unknown as object));
    assert.throws(() => createLogger('app', { level: 'fatal' as 'info' }));
    assert.throws(() => createLogger('app', { level: undefined }));
    assert.throws(() => createLogger('app', { write: undefined as unknown as (line: string) => void }));
    assert.throws(() => createLogger('app', { write: 'nope' as unknown as (line: string) => void }));
  });
  withLogLevel('', () => {
    assert.throws(() => createLogger('app'));
  });
  withLogLevel('verbose', () => {
    assert.throws(() => createLogger('app'));
  });
});

test('formats Error as stack and leaves other args to util.format', () => {
  withLogLevel(undefined, () => {
    const { lines, write } = collect();
    const log = createLogger('app', { write });
    const error = new Error('boom');
    log.error('failed', error);
    assert.match(lines[0]!, /ERROR app failed /);
    assert.ok(lines[0]!.includes(error.stack ?? error.message));
  });
});

test('injected write is used and stderr is not', () => {
  withLogLevel(undefined, () => {
    const writes: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const { lines, write } = collect();
      const log = createLogger('app', { write });
      log.warn('quiet');
      assert.equal(lines.length, 1);
      assert.equal(writes.length, 0);
    } finally {
      process.stderr.write = original;
    }
  });
});
