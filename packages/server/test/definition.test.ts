import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createAdapterRegistry } from '../src/adapter-registry.ts';
import { validateDefinition } from '../src/definition.ts';
import { manifest as testManifest } from './fixtures/test-adapter.ts';
import { caseDef, leaf } from './case-def.ts';

function testRegistry() {
  const registry = createAdapterRegistry();
  registry.register({
    ...testManifest,
    capabilities: [...testManifest.capabilities, { key: 'test.ready', kind: 'Condition', label: 'Ready', ports: [] }],
  });
  return registry;
}

test('validates a nested behavior tree document', () => {
  const definition = caseDef({
    type: 'Sequence',
    children: [
      leaf('Action', 'test.pass'),
      {
        type: 'RetryUntilSuccessful',
        num_attempts: 2,
        child: leaf('Condition', 'test.ready'),
      },
    ],
  });

  assert.deepEqual(validateDefinition(definition, testRegistry()), definition);
});

test('validates an Inverter wrapping a registered leaf', () => {
  const definition = caseDef({
    type: 'Inverter',
    child: leaf('Condition', 'test.ready'),
  });

  assert.deepEqual(validateDefinition(definition, testRegistry()), definition);
});

test('rejects a bare tree that is not a document', () => {
  assert.throws(
    () => validateDefinition({ type: 'Inverter', child: leaf('Condition', 'test.ready') }, testRegistry()),
    /tree document/,
  );
});

test('rejects an Inverter without a child', () => {
  assert.throws(
    () => validateDefinition(caseDef({ type: 'Inverter' } as never), testRegistry()),
    /root(\.trees\.Main)?\.child is invalid|root is invalid/,
  );
});

test('rejects a leaf node without a capability', () => {
  assert.throws(
    () => validateDefinition(caseDef({ type: 'Action' } as never), testRegistry()),
    /adapter is invalid|capability is required/,
  );
});

test('rejects an unknown node type', () => {
  assert.throws(
    () => validateDefinition(caseDef({ type: 'Workflow', children: [] } as never), testRegistry()),
    /type is unsupported|is invalid/,
  );
});

test('rejects an unregistered capability', () => {
  assert.throws(
    () => validateDefinition(caseDef(leaf('Action', 'unknown.action')), testRegistry()),
    /is not registered/,
  );
});

test('rejects a capability used with the wrong leaf kind', () => {
  assert.throws(
    () => validateDefinition(caseDef(leaf('Action', 'test.ready')), testRegistry()),
    /requires Condition, received Action/,
  );
});

test('validates leaf ports against the capability declarations', () => {
  const registry = createAdapterRegistry();
  registry.register({
    ...testManifest,
    capabilities: [
      ...testManifest.capabilities,
      {
        key: 'test.named',
        kind: 'Action',
        label: 'Named',
        ports: [{ name: 'name', direction: 'in', schema: { type: 'string' } }],
      },
    ],
  });

  assert.ok(
    validateDefinition(caseDef(leaf('Action', 'test.named', { ports: { name: { literal: 'ok' } } })), registry),
  );
  assert.throws(
    () => validateDefinition(caseDef(leaf('Action', 'test.named', { ports: {} })), registry),
    /ports\.name is required/,
  );
});

test('accepts a blackboard key binding for an input port', () => {
  const registry = createAdapterRegistry();
  registry.register({
    ...testManifest,
    capabilities: [
      ...testManifest.capabilities,
      {
        key: 'test.read-name',
        kind: 'Action',
        label: 'Read',
        ports: [{ name: 'name', direction: 'in', schema: { type: 'string' } }],
      },
    ],
  });

  assert.ok(
    validateDefinition(
      caseDef(
        leaf('Action', 'test.read-name', {
          ports: { name: { key: 'demo.name' } },
        }),
      ),
      registry,
    ),
  );
});

test('rejects an undeclared port binding', () => {
  const registry = createAdapterRegistry();
  registry.register({
    ...testManifest,
    capabilities: [
      ...testManifest.capabilities,
      {
        key: 'test.read-name',
        kind: 'Action',
        label: 'Read',
        ports: [{ name: 'name', direction: 'in', schema: { type: 'string' } }],
      },
    ],
  });

  assert.throws(
    () =>
      validateDefinition(
        caseDef(
          leaf('Action', 'test.read-name', {
            ports: { missing: { key: 'demo.name' } },
          }),
        ),
        registry,
      ),
    /ports\.missing is not declared/,
  );
});

test('rejects an unregistered leaf in an unreferenced tree', () => {
  assert.throws(
    () =>
      validateDefinition(
        {
          main: 'Main',
          trees: {
            Main: { type: 'Sequence', children: [leaf('Action', 'test.pass')] },
            Dead: leaf('Action', 'unknown.action'),
          },
        },
        testRegistry(),
      ),
    /root\.trees\.Dead\.capability test\/unknown.action is not registered/,
  );
});

test('rejects empty Sequence before catalog checks', () => {
  assert.throws(() => validateDefinition(caseDef({ type: 'Sequence', children: [] }), testRegistry()), /children/);
});

test('rejects unknown fields', () => {
  assert.throws(
    () =>
      validateDefinition(
        caseDef({ type: 'Sequence', children: [leaf('Action', 'test.pass')], label: 'x' } as never),
        testRegistry(),
      ),
    /unrecognized|strict|invalid/i,
  );
});
