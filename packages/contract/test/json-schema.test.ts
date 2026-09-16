import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assertSupportedJsonSchema, matchesJsonSchema } from '../src/json-schema.ts';

const pose = {
  type: 'object',
  properties: {
    x: { type: 'number' },
    y: { type: 'number' },
    yaw: { type: 'number' },
  },
  required: ['x', 'y', 'yaw'],
  additionalProperties: false,
};

test('accepts a string schema', () => {
  assert.doesNotThrow(() => assertSupportedJsonSchema({ type: 'string' }));
});

test('accepts string minLength, integer minimum, pose object, and integer array items', () => {
  assert.doesNotThrow(() => assertSupportedJsonSchema({ type: 'string', minLength: 1 }));
  assert.doesNotThrow(() => assertSupportedJsonSchema({ type: 'integer', minimum: 1 }));
  assert.doesNotThrow(() => assertSupportedJsonSchema(pose));
  assert.doesNotThrow(() =>
    assertSupportedJsonSchema({
      type: 'array',
      items: { type: 'integer', minimum: 1 },
      minItems: 1,
      uniqueItems: true,
    }),
  );
});

test('rejects an empty schema', () => {
  assert.throws(() => assertSupportedJsonSchema({}), /type/);
});

test('rejects a schema without type', () => {
  assert.throws(() => assertSupportedJsonSchema({ minLength: 1 }), /type/);
});

test('rejects const without type', () => {
  assert.throws(() => assertSupportedJsonSchema({ const: 1 }), /type/);
});

test('rejects a union type', () => {
  assert.throws(() => assertSupportedJsonSchema({ type: ['string', 'null'] }), /type/);
});

test('rejects pattern, allOf, and title', () => {
  assert.throws(
    () => assertSupportedJsonSchema({ type: 'string', pattern: '^A' }),
    /unsupported JSON Schema keyword pattern/,
  );
  assert.throws(
    () => assertSupportedJsonSchema({ type: 'string', allOf: [{ type: 'string' }] }),
    /unsupported JSON Schema keyword allOf/,
  );
  assert.throws(
    () => assertSupportedJsonSchema({ type: 'string', title: 'Name' }),
    /unsupported JSON Schema keyword title/,
  );
});

test('rejects an object without properties', () => {
  assert.throws(() => assertSupportedJsonSchema({ type: 'object' }), /properties/);
});

test('rejects an array without items', () => {
  assert.throws(() => assertSupportedJsonSchema({ type: 'array' }), /items/);
});

test('rejects a nested empty property schema', () => {
  assert.throws(() => assertSupportedJsonSchema({ type: 'object', properties: { x: {} } }), /properties\.x/);
});

test('rejects tuple items', () => {
  assert.throws(() => assertSupportedJsonSchema({ type: 'array', items: [{ type: 'string' }] }), /items/);
});

test('object schema rejects extra keys by default', () => {
  assert.equal(
    matchesJsonSchema({ x: 1, extra: true }, { type: 'object', properties: { x: { type: 'number' } } }),
    false,
  );
  assert.equal(matchesJsonSchema({ x: 1 }, { type: 'object', properties: { x: { type: 'number' } } }), true);
});

test('object schema allows extra keys when additionalProperties is true', () => {
  assert.equal(
    matchesJsonSchema(
      { x: 1, extra: true },
      { type: 'object', properties: { x: { type: 'number' } }, additionalProperties: true },
    ),
    true,
  );
});

test('integer rejects a non-integer number', () => {
  assert.equal(matchesJsonSchema(1.5, { type: 'integer' }), false);
  assert.equal(matchesJsonSchema(2, { type: 'integer' }), true);
});
