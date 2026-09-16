import type { CaseDefinition, JsonObject } from './types.ts';

export function isTreeDocument(value: unknown): value is CaseDefinition {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as JsonObject;
  return (
    typeof record.main === 'string' &&
    record.trees !== null &&
    typeof record.trees === 'object' &&
    !Array.isArray(record.trees) &&
    record.type === undefined
  );
}

export function requireCaseDefinition(value: unknown): CaseDefinition {
  if (!isTreeDocument(value)) {
    throw new Error('definition must be a tree document with main and trees');
  }
  if (!(value.main in value.trees)) {
    throw new Error(`definition.main ${value.main} is not in trees`);
  }
  return value;
}

export function parseBraceRef(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^\{([^{}]+)\}$/.exec(value);
  return match?.[1];
}
