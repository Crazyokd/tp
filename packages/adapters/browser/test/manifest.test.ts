import assert from 'node:assert/strict';
import { test } from 'node:test';

import { adapterManifestSchema } from '@tp/contract/adapter';
import type { JsonObject } from '@tp/contract';

import { manifest } from '../src/index.ts';

const capabilityKeys = [
  'browser.goto',
  'browser.click',
  'browser.fill',
  'browser.expect_text',
  'browser.screenshot',
] as const;

test('browser manifest registers five typed capabilities', () => {
  assert.equal(JSON.stringify(manifest).includes('inputSchema'), false);
  assert.equal(JSON.stringify(manifest).includes('outputSchema'), false);
  assert.deepEqual(adapterManifestSchema.parse(manifest), manifest);
  assert.equal(manifest.id, 'browser');
  assert.equal(manifest.moduleEntry, '@tp/adapter-browser');
  assert.deepEqual(
    manifest.capabilities.map(({ key }) => key),
    [...capabilityKeys],
  );
  assert.deepEqual(Object.fromEntries(manifest.capabilities.map(({ key, kind }) => [key, kind])), {
    'browser.goto': 'Action',
    'browser.click': 'Action',
    'browser.fill': 'Action',
    'browser.expect_text': 'Condition',
    'browser.screenshot': 'Action',
  });
  assert.equal(JSON.stringify(manifest).includes('playwright'), false);
});

test('every browser capability declares an optional error output port', () => {
  for (const capability of manifest.capabilities) {
    const error = capability.ports.find((port) => port.name === 'error');
    assert.ok(error, `${capability.key} must declare an error output port`);
    assert.equal(error.direction, 'out');
    assert.equal(error.required, false);
    assert.deepEqual(error.schema, { type: 'string' });
  }
});

test('browser capability schemas are strict objects without pattern', () => {
  for (const capability of manifest.capabilities) {
    assert.ok(capability.ports.length > 0, `${capability.key} must declare ports`);
    for (const port of capability.ports) {
      assertStrictObjectSchemas(port.schema, `${capability.key}.${port.name}.schema`);
    }
    assert.equal(JSON.stringify(capability).includes('"pattern"'), false);
  }

  const byKey = Object.fromEntries(manifest.capabilities.map((capability) => [capability.key, capability]));
  assert.deepEqual(
    byKey['browser.goto']?.ports.filter((port) => port.required).map((port) => port.name),
    ['url'],
  );
  assert.deepEqual(
    byKey['browser.click']?.ports.filter((port) => port.required).map((port) => port.name),
    ['selector'],
  );
  assert.deepEqual(
    byKey['browser.fill']?.ports.filter((port) => port.required).map((port) => port.name),
    ['selector', 'value'],
  );
  assert.deepEqual(
    byKey['browser.expect_text']?.ports.filter((port) => port.required).map((port) => port.name),
    ['selector', 'text'],
  );
  assert.deepEqual(
    byKey['browser.screenshot']?.ports.filter((port) => port.required).map((port) => port.name),
    ['name'],
  );
});

test('adapter package exports createSession and a specifier moduleEntry', async () => {
  const module = await import('@tp/adapter-browser');
  assert.equal(typeof module.createSession, 'function');
  assert.equal(module.manifest.moduleEntry, '@tp/adapter-browser');
  assert.equal('createSession' in module.manifest, false);
});

function assertStrictObjectSchemas(schema: JsonObject, path: string): void {
  if (schema.type === 'object') {
    assert.ok(
      schema.additionalProperties === false || schema.additionalProperties === true,
      `${path} must declare additionalProperties`,
    );
    if (schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)) {
      for (const [key, child] of Object.entries(schema.properties)) {
        assertStrictObjectSchemas(child as JsonObject, `${path}.properties.${key}`);
      }
    }
  }
  if (schema.items && typeof schema.items === 'object' && !Array.isArray(schema.items)) {
    assertStrictObjectSchemas(schema.items as JsonObject, `${path}.items`);
  }
}
