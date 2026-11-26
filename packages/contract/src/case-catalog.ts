import { isDeepStrictEqual } from 'node:util';

import type { AdapterManifest, CapabilityDefinition, PortDefinition } from './adapter-contract.ts';
import { assertSupportedJsonSchema, dialectSchema, matchesJsonSchema } from './json-schema.ts';
import { collectLeafSessions } from './sessions.ts';
import type {
  CaseDefinition,
  JsonObject,
  LeafNode,
  PortBinding,
  SessionBinding,
  SubTreeNode,
  TreeNode,
} from './types.ts';

type Frame = {
  id: number;
  remap: Map<string, string>;
  parent: Frame | null;
};

export function validateCaseCatalog(doc: CaseDefinition, manifests: readonly AdapterManifest[]): void {
  const byId = indexManifests(manifests);
  for (const [name, tree] of Object.entries(doc.trees)) {
    walk(tree, `root.trees.${name}`, byId);
  }
  let nextFrameId = 0;
  for (const [name, tree] of Object.entries(doc.trees)) {
    walkKeys(
      tree,
      `root.trees.${name}`,
      byId,
      doc.trees,
      doc.sessions,
      {
        id: nextFrameId++,
        remap: new Map(),
        parent: null,
      },
      new Map(),
      () => nextFrameId++,
      new Set([name]),
    );
  }
  validateSessionRows(doc, byId);
}

function indexManifests(manifests: readonly AdapterManifest[]): Map<string, AdapterManifest> {
  const byId = new Map<string, AdapterManifest>();
  for (const manifest of manifests) {
    if (byId.has(manifest.id)) {
      throw new Error(`adapter ${manifest.id} is declared more than once`);
    }
    const keys = new Set<string>();
    for (const capability of manifest.capabilities) {
      if (keys.has(capability.key)) {
        throw new Error(`capability ${capability.key} is declared more than once by adapter ${manifest.id}`);
      }
      keys.add(capability.key);
    }
    for (const capability of manifest.capabilities) {
      for (const port of capability.ports) {
        assertSupportedJsonSchema(port.schema, `${manifest.id}/${capability.key}.ports.${port.name}.schema`);
      }
    }
    for (const port of manifest.session?.ports ?? []) {
      if (port.direction !== 'in') {
        throw new Error(`adapter ${manifest.id} session port ${port.name} must use direction in`);
      }
      assertSupportedJsonSchema(port.schema, `${manifest.id}.session.ports.${port.name}.schema`);
    }
    byId.set(manifest.id, manifest);
  }
  return byId;
}

function validateSessionRows(doc: CaseDefinition, byId: Map<string, AdapterManifest>): void {
  const needed = collectLeafSessions(doc.trees);
  const rows = new Map<string, { row: SessionBinding; index: number }>();
  for (const [index, row] of doc.sessions.entries()) {
    const key = `${row.adapter}\0${row.actor}`;
    rows.set(key, { row, index });
  }
  for (const pair of needed) {
    const key = `${pair.adapter}\0${pair.actor}`;
    const found = rows.get(key);
    if (!found) {
      throw new Error(`root.sessions is missing ${pair.adapter}/${pair.actor}`);
    }
    const manifest = byId.get(pair.adapter);
    if (!manifest) {
      throw new Error(`root.sessions.${found.index}.adapter ${pair.adapter} is not registered`);
    }
    validateSessionPortBindings(found.row.ports ?? {}, manifest, `root.sessions.${found.index}`);
    rows.delete(key);
  }
  const extra = rows.values().next().value as { row: SessionBinding; index: number } | undefined;
  if (extra) {
    throw new Error(`root.sessions.${extra.index} ${extra.row.adapter}/${extra.row.actor} is not used by any leaf`);
  }
}

function validateSessionPortBindings(
  bindings: Record<string, PortBinding>,
  manifest: AdapterManifest,
  path: string,
): void {
  const ports = manifest.session?.ports ?? [];
  const declared = new Map(ports.map((port) => [port.name, port]));
  for (const name of Object.keys(bindings)) {
    if (!declared.has(name)) throw new Error(`${path}.ports.${name} is not declared by ${manifest.id} session`);
  }
  for (const port of ports) {
    validatePortBinding(bindings[port.name], port, path);
  }
}

function walk(definition: TreeNode, path: string, byId: Map<string, AdapterManifest>): void {
  if (definition.type === 'SubTree') return;
  if ('capability' in definition) {
    validateLeaf(definition, path, byId);
    return;
  }
  if ('children' in definition) {
    definition.children.forEach((child, index) => walk(child, `${path}.children.${index}`, byId));
    return;
  }
  if ('if' in definition) {
    walk(definition.if, `${path}.if`, byId);
    walk(definition.then, `${path}.then`, byId);
    if (definition.else) walk(definition.else, `${path}.else`, byId);
    return;
  }
  walk(definition.child, `${path}.child`, byId);
}

function validateLeaf(definition: LeafNode, path: string, byId: Map<string, AdapterManifest>): void {
  const capability = byId
    .get(definition.adapter)
    ?.capabilities.find((candidate) => candidate.key === definition.capability);
  if (!capability) {
    throw new Error(`${path}.capability ${definition.adapter}/${definition.capability} is not registered`);
  }
  if (capability.kind !== definition.type) {
    throw new Error(
      `${path} capability ${definition.capability} requires ${capability.kind}, received ${definition.type}`,
    );
  }
  validatePortBindings(definition.ports ?? {}, capability, path);
}

function validatePortBindings(
  bindings: Record<string, PortBinding>,
  capability: CapabilityDefinition,
  path: string,
): void {
  const declared = new Map(capability.ports.map((port) => [port.name, port]));
  for (const name of Object.keys(bindings)) {
    if (!declared.has(name)) throw new Error(`${path}.ports.${name} is not declared by ${capability.key}`);
  }
  for (const port of capability.ports) {
    validatePortBinding(bindings[port.name], port, path);
  }
}

function validatePortBinding(binding: PortBinding | undefined, port: PortDefinition, path: string): void {
  const required = port.required !== false;
  if (!binding) {
    if (required && port.default === undefined) {
      if (port.direction === 'out') {
        throw new Error(`${path}.ports.${port.name} must bind an output to a blackboard key`);
      }
      throw new Error(`${path}.ports.${port.name} is required`);
    }
    return;
  }
  if (port.direction === 'out' && 'literal' in binding) {
    throw new Error(`${path}.ports.${port.name} is an output and cannot be a literal`);
  }
  if ('literal' in binding && !matchesJsonSchema(binding.literal, port.schema)) {
    throw new Error(`${path}.ports.${port.name} literal does not match schema`);
  }
}

function walkKeys(
  definition: TreeNode,
  path: string,
  byId: Map<string, AdapterManifest>,
  trees: Record<string, TreeNode>,
  sessions: readonly SessionBinding[],
  frame: Frame,
  seen: Map<string, JsonObject>,
  nextFrameId: () => number,
  walking: Set<string>,
): void {
  if (frame.parent === null) recordSessionKeys(sessions, byId, frame, seen);
  if (definition.type === 'SubTree') {
    if (walking.has(definition.id)) return;
    const child = trees[definition.id];
    if (!child) return;
    walkKeys(
      child,
      `root.trees.${definition.id}`,
      byId,
      trees,
      sessions,
      pushFrame(frame, definition, nextFrameId),
      seen,
      nextFrameId,
      new Set(walking).add(definition.id),
    );
    return;
  }
  if ('capability' in definition) {
    recordLeafKeys(definition, path, byId, frame, seen);
    return;
  }
  if ('children' in definition) {
    definition.children.forEach((child, index) => {
      walkKeys(child, `${path}.children.${index}`, byId, trees, sessions, frame, seen, nextFrameId, walking);
    });
    return;
  }
  if ('if' in definition) {
    walkKeys(definition.if, `${path}.if`, byId, trees, sessions, frame, seen, nextFrameId, walking);
    walkKeys(definition.then, `${path}.then`, byId, trees, sessions, frame, seen, nextFrameId, walking);
    if (definition.else)
      walkKeys(definition.else, `${path}.else`, byId, trees, sessions, frame, seen, nextFrameId, walking);
    return;
  }
  walkKeys(definition.child, `${path}.child`, byId, trees, sessions, frame, seen, nextFrameId, walking);
}

function recordSessionKeys(
  sessions: readonly SessionBinding[],
  byId: Map<string, AdapterManifest>,
  frame: Frame,
  seen: Map<string, JsonObject>,
): void {
  for (const [index, row] of sessions.entries()) {
    const manifest = byId.get(row.adapter);
    if (!manifest) continue;
    const bindings = row.ports ?? {};
    for (const port of manifest.session?.ports ?? []) {
      const binding = bindings[port.name];
      if (!binding || !('key' in binding)) continue;
      const resolved = resolveKey(frame, binding.key);
      const identity = `${resolved.scopeId}:${resolved.key}`;
      const existing = seen.get(identity);
      const candidate = dialectSchema(port.schema);
      if (existing && !isDeepStrictEqual(existing, candidate)) {
        throw new Error(`root.sessions.${index}.ports.${port.name} key ${resolved.key} schema does not match`);
      }
      if (!existing) seen.set(identity, candidate);
    }
  }
}

function pushFrame(parent: Frame, node: SubTreeNode, nextFrameId: () => number): Frame {
  const remap = new Map<string, string>();
  for (const [inner, binding] of Object.entries(node.remap ?? {})) {
    remap.set(inner, binding.key);
  }
  return { id: nextFrameId(), remap, parent };
}

function recordLeafKeys(
  definition: LeafNode,
  path: string,
  byId: Map<string, AdapterManifest>,
  frame: Frame,
  seen: Map<string, JsonObject>,
): void {
  const capability = byId
    .get(definition.adapter)
    ?.capabilities.find((candidate) => candidate.key === definition.capability);
  if (!capability) return;
  const bindings = definition.ports ?? {};
  for (const port of capability.ports) {
    const binding = bindings[port.name];
    if (!binding || !('key' in binding)) continue;
    const resolved = resolveKey(frame, binding.key);
    const identity = `${resolved.scopeId}:${resolved.key}`;
    const existing = seen.get(identity);
    const candidate = dialectSchema(port.schema);
    if (existing && !isDeepStrictEqual(existing, candidate)) {
      throw new Error(`${path}.ports.${port.name} key ${resolved.key} schema does not match`);
    }
    if (!existing) seen.set(identity, candidate);
  }
}

function resolveKey(frame: Frame, key: string): { scopeId: number; key: string } {
  let current: Frame | null = frame;
  let currentKey = key;
  while (current) {
    const remapped = current.remap.get(currentKey);
    if (remapped !== undefined) {
      currentKey = remapped;
      current = current.parent;
      continue;
    }
    return { scopeId: current.id, key: currentKey };
  }
  return { scopeId: 0, key: currentKey };
}
