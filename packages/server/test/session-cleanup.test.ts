import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';

import type { AdapterSession } from '@tp/contract/adapter';
import { cleanupAdapterSessions } from '../src/session-cleanup.ts';

function session(cleanup: () => Promise<void>): AdapterSession {
  return {
    async tick() {
      return { status: 'SUCCESS' };
    },
    async halt() {},
    cleanup,
  };
}

test('consumers fully close before their provider can release and reuse its slot', async () => {
  const gate = Promise.withResolvers<void>();
  const calls: string[] = [];
  const cleanup = cleanupAdapterSessions(
    [
      session(async () => {
        calls.push('provider released');
      }),
      session(async () => {
        calls.push('browser closing');
        await gate.promise;
        calls.push('browser closed');
      }),
    ],
    { timeoutMs: 1000 },
  );
  await setImmediate();
  assert.deepEqual(calls, ['browser closing']);
  gate.resolve();
  assert.deepEqual(await cleanup, []);
  assert.deepEqual(calls, ['browser closing', 'browser closed', 'provider released']);
});

test('consumer cleanup failure retains the provider instead of reusing its endpoint', async () => {
  let released = false;
  const errors = await cleanupAdapterSessions(
    [
      session(async () => {
        released = true;
      }),
      session(async () => {
        throw new Error('Browser still owns its connection');
      }),
    ],
    { timeoutMs: 1000 },
  );
  assert.deepEqual(errors, ['Browser still owns its connection']);
  assert.equal(released, false);
});

test('late consumer cleanup completion cannot release a provider after the shared deadline', async () => {
  const gate = Promise.withResolvers<void>();
  let released = false;
  const errors = await cleanupAdapterSessions(
    [
      session(async () => {
        released = true;
      }),
      session(async () => {
        await gate.promise;
      }),
    ],
    { timeoutMs: 20 },
  );
  assert.deepEqual(errors, ['session cleanup timed out after 20ms']);
  gate.resolve();
  await setImmediate();
  assert.equal(released, false);
});
