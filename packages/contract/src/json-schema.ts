import { isDeepStrictEqual } from 'node:util';

import { isJsonValue } from './json-value.ts';
import type { JsonObject } from './types.ts';

const TYPES = new Set(['array', 'boolean', 'integer', 'null', 'number', 'object', 'string']);

const KEYWORDS_BY_TYPE: Record<string, ReadonlySet<string>> = {
  object: new Set(['type', 'const', 'enum', 'properties', 'required', 'additionalProperties']),
  array: new Set(['type', 'const', 'enum', 'items', 'minItems', 'maxItems', 'uniqueItems']),
  string: new Set(['type', 'const', 'enum', 'minLength', 'maxLength']),
  number: new Set(['type', 'const', 'enum', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum']),
  integer: new Set(['type', 'const', 'enum', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum']),
  boolean: new Set(['type', 'const', 'enum']),
  null: new Set(['type', 'const', 'enum']),
};

export function assertSupportedJsonSchema(schema: JsonObject, path = 'schema'): void {
  const type = schema.type;
  if (typeof type !== 'string' || !TYPES.has(type)) {
    throw new Error(`${path}.type is unsupported`);
  }
  const allowed = KEYWORDS_BY_TYPE[type]!;
  for (const key of Object.keys(schema)) {
    if (!allowed.has(key)) throw new Error(`${path} uses unsupported JSON Schema keyword ${key}`);
  }
  if (
    schema.enum !== undefined &&
    (!Array.isArray(schema.enum) || schema.enum.length === 0 || !schema.enum.every((item) => isJsonValue(item)))
  ) {
    throw new Error(`${path}.enum must be a non-empty array of JSON values`);
  }
  if ('const' in schema && !isJsonValue(schema.const)) throw new Error(`${path}.const must be a JSON value`);
  if (type === 'object') {
    if (!isObject(schema.properties)) throw new Error(`${path}.properties is required`);
    if (schema.required !== undefined) {
      if (
        !Array.isArray(schema.required) ||
        schema.required.length === 0 ||
        schema.required.some((item) => typeof item !== 'string')
      ) {
        throw new Error(`${path}.required must be a non-empty array of strings`);
      }
      if (new Set(schema.required).size !== schema.required.length)
        throw new Error(`${path}.required must contain unique names`);
      for (const name of schema.required) {
        if (!(name in schema.properties)) throw new Error(`${path}.required contains unknown property ${name}`);
      }
    }
    if (
      schema.additionalProperties !== undefined &&
      schema.additionalProperties !== true &&
      schema.additionalProperties !== false &&
      !isObject(schema.additionalProperties)
    ) {
      throw new Error(`${path}.additionalProperties must be a boolean or schema object`);
    }
    for (const [key, child] of Object.entries(schema.properties)) {
      if (!isObject(child)) throw new Error(`${path}.properties.${key} must be a schema object`);
      assertSupportedJsonSchema(child, `${path}.properties.${key}`);
    }
    if (isObject(schema.additionalProperties))
      assertSupportedJsonSchema(schema.additionalProperties, `${path}.additionalProperties`);
  }
  if (type === 'array') {
    if (!isObject(schema.items)) throw new Error(`${path}.items is required`);
    assertSupportedJsonSchema(schema.items, `${path}.items`);
    for (const keyword of ['minItems', 'maxItems'] as const) {
      const value = schema[keyword];
      if (value !== undefined && (!Number.isInteger(value) || (value as number) < 0)) {
        throw new Error(`${path}.${keyword} must be a non-negative integer`);
      }
    }
    if (schema.uniqueItems !== undefined && typeof schema.uniqueItems !== 'boolean') {
      throw new Error(`${path}.uniqueItems must be a boolean`);
    }
  }
  if (type === 'string') {
    for (const keyword of ['minLength', 'maxLength'] as const) {
      const value = schema[keyword];
      if (value !== undefined && (!Number.isInteger(value) || (value as number) < 0)) {
        throw new Error(`${path}.${keyword} must be a non-negative integer`);
      }
    }
  }
  if (type === 'number' || type === 'integer') {
    for (const keyword of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum'] as const) {
      const value = schema[keyword];
      if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) {
        throw new Error(`${path}.${keyword} must be a finite number`);
      }
    }
  }
}

export function dialectSchema(schema: JsonObject): JsonObject {
  if (schema.type !== 'object') {
    if (schema.type === 'array' && isObject(schema.items)) {
      return { ...schema, items: dialectSchema(schema.items) };
    }
    return schema;
  }
  const properties = isObject(schema.properties)
    ? Object.fromEntries(
        Object.entries(schema.properties).map(([key, child]) => [key, isObject(child) ? dialectSchema(child) : child]),
      )
    : schema.properties;
  const additionalProperties =
    schema.additionalProperties === undefined
      ? false
      : isObject(schema.additionalProperties)
        ? dialectSchema(schema.additionalProperties)
        : schema.additionalProperties;
  return { ...schema, properties, additionalProperties };
}

export function matchesJsonSchema(value: unknown, schema: JsonObject): boolean {
  if (!isJsonValue(value)) return false;
  if ('const' in schema && !isDeepStrictEqual(value, schema.const)) return false;
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => isDeepStrictEqual(item, value))) return false;

  const type = schema.type;
  if (type === 'null') return value === null;
  if (type === 'boolean') return typeof value === 'boolean';
  if (type === 'string') {
    if (typeof value !== 'string') return false;
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) return false;
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) return false;
    return true;
  }
  if (type === 'number' || type === 'integer') {
    if (typeof value !== 'number' || !Number.isFinite(value) || (type === 'integer' && !Number.isInteger(value)))
      return false;
    if (typeof schema.minimum === 'number' && value < schema.minimum) return false;
    if (typeof schema.maximum === 'number' && value > schema.maximum) return false;
    if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) return false;
    if (typeof schema.exclusiveMaximum === 'number' && value >= schema.exclusiveMaximum) return false;
    return true;
  }
  if (type === 'object') {
    if (!isObject(value)) return false;
    const properties = isObject(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required) ? schema.required.map(String) : [];
    if (required.some((key) => !(key in value))) return false;
    for (const [key, childSchema] of Object.entries(properties)) {
      if (key in value && isObject(childSchema) && !matchesJsonSchema(value[key], childSchema)) return false;
    }
    for (const key of Object.keys(value)) {
      if (key in properties) continue;
      if (schema.additionalProperties === true) continue;
      if (isObject(schema.additionalProperties) && matchesJsonSchema(value[key], schema.additionalProperties)) continue;
      return false;
    }
    return true;
  }
  if (type === 'array') {
    if (!Array.isArray(value)) return false;
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) return false;
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) return false;
    if (
      schema.uniqueItems === true &&
      value.some((item, index) => value.slice(index + 1).some((other) => isDeepStrictEqual(item, other)))
    )
      return false;
    return !isObject(schema.items) || value.every((item) => matchesJsonSchema(item, schema.items as JsonObject));
  }
  return false;
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export { isJsonValue } from './json-value.ts';
