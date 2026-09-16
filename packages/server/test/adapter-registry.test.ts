import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createAdapterRegistry } from '../src/adapter-registry.ts';

const manifest = {
  id: 'demo',
  moduleEntry: 'file:///tmp/demo-adapter.js',
  capabilities: [
    {
      key: 'demo.move',
      kind: 'Action' as const,
      label: 'Move',
      ports: [
        {
          name: 'distance',
          direction: 'in' as const,
          schema: { type: 'number' },
        },
      ],
    },
  ],
};

test('adapter registration exposes its capabilities and owner', () => {
  const registry = createAdapterRegistry();

  registry.register(manifest);

  assert.deepEqual(registry.listCapabilities(), [{ ...manifest.capabilities[0], adapter: 'demo' }]);
  assert.equal(registry.getCapability('demo', 'demo.move').key, 'demo.move');
  assert.equal(registry.getAdapter('demo').id, 'demo');
});

test('registering the same manifest is idempotent', () => {
  const registry = createAdapterRegistry();

  registry.register(manifest);
  registry.register(structuredClone(manifest));

  assert.equal(registry.listAdapters().length, 1);
});

test('registering different content for an existing adapter id is rejected', () => {
  const registry = createAdapterRegistry();
  registry.register(manifest);

  assert.throws(
    () => registry.register({ ...manifest, moduleEntry: 'file:///tmp/other.js' }),
    /adapter demo is already registered with different content/,
  );
});

test('duplicate capability keys across adapters are allowed', () => {
  const registry = createAdapterRegistry();
  registry.register(manifest);
  registry.register({ ...manifest, id: 'other', moduleEntry: 'file:///tmp/other.js' });

  assert.equal(registry.getCapability('demo', 'demo.move').key, 'demo.move');
  assert.equal(registry.getCapability('other', 'demo.move').key, 'demo.move');
});

test('duplicate capability keys within one adapter are rejected', () => {
  const registry = createAdapterRegistry();

  assert.throws(
    () => registry.register({ ...manifest, capabilities: [...manifest.capabilities, ...manifest.capabilities] }),
    /capability demo.move is declared more than once by adapter demo/,
  );
});

test('unsupported JSON Schema keywords are rejected during registration', () => {
  const registry = createAdapterRegistry();
  const unsupported = structuredClone(manifest);
  unsupported.capabilities[0]!.ports[0]!.schema = { type: 'string', $ref: '#/$defs/input' };

  assert.throws(() => registry.register(unsupported), /unsupported JSON Schema keyword \$ref/);
});

test('empty port schema is rejected during registration', () => {
  const registry = createAdapterRegistry();
  const empty = structuredClone(manifest);
  empty.capabilities[0]!.ports[0]!.schema = {};

  assert.throws(() => registry.register(empty), /type/);
});

test('malformed supported JSON Schema constraints are rejected', () => {
  const registry = createAdapterRegistry();
  const malformed = structuredClone(manifest);
  malformed.capabilities[0]!.ports[0]!.schema = { type: 'string', minLength: 'one' };

  assert.throws(() => registry.register(malformed), /minLength must be a non-negative integer/);
});
