import { matchesJsonSchema, type JsonObject, type LeafNode, type PortBinding, type SessionBinding } from '@tp/contract';
import type { CapabilityDefinition, PortDefinition } from '@tp/contract/adapter';

export class MissingLeafInputError extends Error {}
export class InvalidLeafOutputError extends Error {}

export function assembleSessionInput(
  binding: SessionBinding,
  ports: readonly PortDefinition[],
  lookup: (key: string) => unknown,
): JsonObject {
  return assembleLeafInput(
    {
      type: 'Action',
      adapter: binding.adapter,
      actor: binding.actor,
      capability: 'session',
      ports: binding.ports,
    },
    { key: 'session', kind: 'Action', label: 'session', ports: [...ports] },
    lookup,
  );
}

export function assembleLeafInput(
  leaf: LeafNode,
  capability: CapabilityDefinition,
  lookup: (key: string) => unknown,
): JsonObject {
  const input: JsonObject = {};
  for (const port of capability.ports) {
    if (port.direction === 'out') continue;
    const required = port.required !== false;
    const binding = leaf.ports?.[port.name];
    if (!binding) {
      if (required && port.default === undefined) {
        throw new MissingLeafInputError(`required port ${port.name} is not bound on ${capability.key}`);
      }
      if (port.default !== undefined) input[port.name] = port.default;
      continue;
    }
    const value = readBinding(binding, lookup, port, required);
    if (value !== undefined) input[port.name] = value;
  }
  return input;
}

export function applyLeafOutput(
  leaf: LeafNode,
  capability: CapabilityDefinition,
  output: JsonObject | undefined,
  write: (key: string, value: unknown) => void,
): void {
  if (!output) return;
  for (const [name, value] of Object.entries(output)) {
    const port = capability.ports.find((candidate) => candidate.name === name);
    if (!port || port.direction === 'in') {
      throw new InvalidLeafOutputError(`capability ${capability.key} does not declare output port ${name}`);
    }
    if (!matchesJsonSchema(value, port.schema)) {
      throw new InvalidLeafOutputError(`output port ${name} does not match schema for ${capability.key}`);
    }
    const binding = leaf.ports?.[name];
    if (!binding || !('key' in binding)) continue;
    write(binding.key, value);
  }
}

function readBinding(
  binding: PortBinding,
  lookup: (key: string) => unknown,
  port: PortDefinition,
  required: boolean,
): unknown {
  if ('literal' in binding) {
    if (!matchesJsonSchema(binding.literal, port.schema)) {
      throw new MissingLeafInputError(`literal for port ${port.name} does not match schema`);
    }
    return binding.literal;
  }
  const value = lookup(binding.key);
  if (value === undefined) {
    if (required && port.default === undefined) {
      throw new MissingLeafInputError(`blackboard key ${binding.key} is missing for port ${port.name}`);
    }
    return port.default;
  }
  if (!matchesJsonSchema(value, port.schema)) {
    throw new MissingLeafInputError(`blackboard key ${binding.key} does not match schema for port ${port.name}`);
  }
  return value;
}
