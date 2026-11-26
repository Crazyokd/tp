import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assembleSessionInput, MissingLeafInputError } from '../src/leaf-ports.ts';

const containerPort = {
  name: 'container',
  direction: 'in' as const,
  schema: { type: 'string', minLength: 1 },
  required: true,
};

test('assembleSessionInput returns only declared session ports from literals', () => {
  const input = assembleSessionInput(
    {
      adapter: 'demo',
      actor: 'robot',
      ports: { container: { literal: 'demo-dev' }, extra: { literal: 'nope' } },
    },
    [containerPort],
    () => undefined,
  );
  assert.deepEqual(input, { container: 'demo-dev' });
});

test('assembleSessionInput reads a blackboard key and falls back to the port default', () => {
  const input = assembleSessionInput(
    { adapter: 'browser', actor: 'browser', ports: { origin: { key: 'browser.origin' } } },
    [
      {
        name: 'origin',
        direction: 'in',
        schema: { type: 'string' },
        required: true,
        default: 'http://127.0.0.1:18188',
      },
    ],
    () => undefined,
  );
  assert.deepEqual(input, { origin: 'http://127.0.0.1:18188' });
  const overridden = assembleSessionInput(
    { adapter: 'browser', actor: 'browser', ports: { origin: { key: 'browser.origin' } } },
    [
      {
        name: 'origin',
        direction: 'in',
        schema: { type: 'string' },
        required: true,
        default: 'http://127.0.0.1:18188',
      },
    ],
    (key) => (key === 'browser.origin' ? 'http://127.0.0.1:28188' : undefined),
  );
  assert.deepEqual(overridden, { origin: 'http://127.0.0.1:28188' });
});

test('assembleSessionInput fails when a required session port is missing', () => {
  assert.throws(
    () => assembleSessionInput({ adapter: 'demo', actor: 'robot', ports: {} }, [containerPort], () => undefined),
    MissingLeafInputError,
  );
  assert.throws(
    () =>
      assembleSessionInput(
        { adapter: 'demo', actor: 'robot', ports: { container: { key: 'box' } } },
        [containerPort],
        () => undefined,
      ),
    /blackboard key box is missing/,
  );
});
