import {
  requireCaseDefinition,
  type CaseDefinition,
  type CatalogCapability,
  type LeafNode,
  type NodeType,
  type TreeNode,
} from '@tp/contract';

export const NODE_TYPES: NodeType[] = [
  'Sequence',
  'ReactiveSequence',
  'Fallback',
  'ReactiveFallback',
  'Parallel',
  'ParallelAll',
  'RetryUntilSuccessful',
  'Repeat',
  'Timeout',
  'Delay',
  'Inverter',
  'ForceSuccess',
  'ForceFailure',
  'KeepRunningUntilFailure',
  'RunOnce',
  'IfThenElse',
  'WhileDoElse',
  'Switch',
  'SubTree',
  'Action',
  'Condition',
];
export const LEAF_TYPES = new Set<NodeType>(['Action', 'Condition']);
export const CHILDREN_TYPES = new Set<NodeType>([
  'Sequence',
  'ReactiveSequence',
  'Fallback',
  'ReactiveFallback',
  'Parallel',
  'ParallelAll',
  'Switch',
]);
const WRAP_TYPES = new Set<NodeType>([
  'RetryUntilSuccessful',
  'Repeat',
  'Timeout',
  'Delay',
  'Inverter',
  'ForceSuccess',
  'ForceFailure',
  'KeepRunningUntilFailure',
  'RunOnce',
]);
const BRANCH_KEYS = new Set(['child', 'if', 'then', 'else', 'tree']);

export type EditResult = {
  definition: CaseDefinition;
  selectedPath: string;
};

export type DropMode = 'auto' | 'append' | 'replace-child' | 'wrap';
export type NodeTemplate = {
  type: NodeType;
  capability?: string;
  adapter?: string;
};
export type NodeInput = NodeType | NodeTemplate;
export type WrapperFields = {
  num_attempts?: number;
  num_cycles?: number;
  msec?: number;
  success_count?: number;
  failure_count?: number;
  max_failures?: number;
  variable?: string;
  cases?: string[];
  id?: string;
};

export function defaultDefinition(): CaseDefinition {
  return { main: 'Main', trees: { Main: { type: 'Sequence', children: [] } } };
}

export function rootTree(definition: CaseDefinition): TreeNode {
  const document = requireCaseDefinition(definition);
  return document.trees[document.main]!;
}

export function makeNode(input: NodeInput): TreeNode {
  const template = typeof input === 'string' ? { type: input } : input;
  const { type } = template;
  if (CHILDREN_TYPES.has(type) && type !== 'Switch') {
    return { type, children: [] } as TreeNode;
  }
  if (type === 'Switch') {
    return { type, variable: 'state', cases: [], children: [{ type: 'Sequence', children: [] }] };
  }
  if (type === 'SubTree') return { type, id: 'Main' };
  if (type === 'RetryUntilSuccessful') return { type, num_attempts: 2, child: { type: 'Sequence', children: [] } };
  if (type === 'Repeat') return { type, num_cycles: 2, child: { type: 'Sequence', children: [] } };
  if (type === 'Timeout' || type === 'Delay') return { type, msec: 30000, child: { type: 'Sequence', children: [] } };
  if (WRAP_TYPES.has(type)) return { type, child: { type: 'Sequence', children: [] } } as TreeNode;
  if (type === 'IfThenElse' || type === 'WhileDoElse') {
    return {
      type,
      if: { type: 'Sequence', children: [] },
      then: { type: 'Sequence', children: [] },
    };
  }
  if (!template.capability) throw new Error(`leaf node ${type} requires a capability template`);
  return {
    type,
    adapter: template.adapter ?? '',
    actor: '',
    capability: template.capability,
    ports: {},
  } as LeafNode;
}

export function getNode(definition: CaseDefinition, path: string): TreeNode {
  if (!path) return rootTree(definition);
  const parts = path.split('.').filter(Boolean);
  let node = rootTree(definition);
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    const record = node as unknown as Record<string, TreeNode | TreeNode[]>;
    if (part === 'children') {
      const index = Number(parts[i + 1]);
      const children = record[part] as TreeNode[];
      node = children[index] ?? node;
      i += 1;
    } else if (part && BRANCH_KEYS.has(part)) {
      node = record[part] as TreeNode;
    }
  }
  return node;
}

export function insertNode(definition: CaseDefinition, input: NodeInput, targetPath: string): EditResult {
  const next = clone(definition);
  const node = makeNode(input);
  const selected = getNode(next, targetPath);

  if (isChildContainer(selected)) {
    if (selected.type === 'Switch') {
      return appendSwitchCase(next, targetPath, selected, node);
    }
    selected.children.push(node);
    return { definition: next, selectedPath: childPath(targetPath, 'children', selected.children.length - 1) };
  }
  if (WRAP_TYPES.has(selected.type)) {
    (selected as Extract<TreeNode, { child: TreeNode }>).child = node;
    return { definition: next, selectedPath: propPath(targetPath, 'child') };
  }

  const parent = arrayParentFor(next, targetPath);
  if (parent) {
    const owner = getNode(next, parent.path);
    if (owner.type === 'Switch') {
      ensureSwitchDefault(owner);
      const defaultIndex = owner.children.length - 1;
      const insertAt = Math.min(parent.index + 1, defaultIndex);
      owner.cases.splice(insertAt, 0, '');
      owner.children.splice(insertAt, 0, node);
      return { definition: next, selectedPath: childPath(parent.path, parent.key, insertAt) };
    }
    parent.array.splice(parent.index + 1, 0, node);
    return { definition: next, selectedPath: childPath(parent.path, parent.key, parent.index + 1) };
  }
  return { definition: writeRoot(next, node), selectedPath: '' };
}

export function dropNode(
  definition: CaseDefinition,
  input: NodeInput,
  targetPath: string,
  mode: DropMode = 'auto',
): EditResult {
  if (mode === 'wrap') return wrapNode(definition, input, targetPath);
  if (mode === 'replace-child') return replaceSingleChild(definition, input, targetPath);
  return insertNode(definition, input, targetPath);
}

export function wrapNode(definition: CaseDefinition, input: NodeInput, targetPath: string): EditResult {
  const type = typeof input === 'string' ? input : input.type;
  if (!WRAP_TYPES.has(type)) return insertNode(definition, input, targetPath);
  const wrapper = makeNode(input);
  if (!('child' in wrapper)) return insertNode(definition, input, targetPath);
  wrapper.child = clone(getNode(definition, targetPath));
  return replaceNode(definition, targetPath, wrapper);
}

export function typeSelectValue(node: TreeNode): string {
  if (LEAF_TYPES.has(node.type) && 'capability' in node) {
    return `leaf:${node.adapter}::${node.capability}`;
  }
  return node.type;
}

export function nodeInputFromTypeSelect(value: string, capabilities: readonly CatalogCapability[]): NodeInput {
  if (!value.startsWith('leaf:')) return value as NodeType;
  const token = value.slice('leaf:'.length);
  const separator = token.indexOf('::');
  if (separator <= 0 || separator === token.length - 2) {
    throw new Error(`invalid leaf type selection ${value}`);
  }
  const adapter = token.slice(0, separator);
  const key = token.slice(separator + 2);
  const capability = capabilities.find((item) => item.adapter === adapter && item.key === key);
  if (!capability) throw new Error(`unknown capability ${adapter}/${key}`);
  return { type: capability.kind, adapter: capability.adapter, capability: capability.key };
}

export function replaceNodeType(definition: CaseDefinition, path: string, input: NodeInput): EditResult {
  return replaceNode(definition, path, makeNode(input));
}

export function updateLeaf(
  definition: CaseDefinition,
  path: string,
  input: {
    adapter: string;
    capability: string;
    actor: string;
    ports: LeafNode['ports'];
  },
): EditResult {
  const next = clone(definition);
  const node = getNode(next, path);
  if (!isLeaf(node)) return { definition: next, selectedPath: path };
  node.adapter = input.adapter.trim();
  node.capability = input.capability.trim();
  node.actor = input.actor.trim();
  node.ports = input.ports ?? {};
  return { definition: next, selectedPath: path };
}

export function updateWrapper(definition: CaseDefinition, path: string, input: WrapperFields): EditResult {
  const next = clone(definition);
  const node = getNode(next, path);
  if (node.type === 'RetryUntilSuccessful' && input.num_attempts !== undefined) {
    node.num_attempts = normalizeAttempt(input.num_attempts);
  }
  if (node.type === 'Repeat' && input.num_cycles !== undefined) {
    node.num_cycles = normalizeAttempt(input.num_cycles);
  }
  if ((node.type === 'Timeout' || node.type === 'Delay') && input.msec !== undefined) {
    node.msec = Math.max(1, Math.floor(input.msec));
  }
  if (node.type === 'Parallel') {
    if (input.success_count !== undefined) node.success_count = Math.floor(input.success_count);
    if (input.failure_count !== undefined) node.failure_count = Math.floor(input.failure_count);
  }
  if (node.type === 'ParallelAll' && input.max_failures !== undefined) {
    node.max_failures = normalizeAttempt(input.max_failures);
  }
  if (node.type === 'Switch') {
    if (input.variable !== undefined) node.variable = input.variable.trim() || node.variable;
    if (input.cases !== undefined) node.cases = input.cases;
  }
  if (node.type === 'SubTree' && input.id !== undefined) {
    node.id = input.id.trim() || node.id;
  }
  return { definition: next, selectedPath: path };
}

export function deleteNode(definition: CaseDefinition, path: string): EditResult {
  const next = clone(definition);
  const parent = arrayParentFor(next, path);
  if (!parent) return { definition: next, selectedPath: path };
  const owner = getNode(next, parent.path);
  if (owner.type === 'Switch') {
    if (parent.index >= owner.children.length - 1) return { definition: next, selectedPath: path };
    owner.cases.splice(parent.index, 1);
    owner.children.splice(parent.index, 1);
    return { definition: next, selectedPath: parent.path };
  }
  parent.array.splice(parent.index, 1);
  return { definition: next, selectedPath: parent.path };
}

export function moveNode(definition: CaseDefinition, path: string, delta: number): EditResult {
  const next = clone(definition);
  const parent = arrayParentFor(next, path);
  if (!parent) return { definition: next, selectedPath: path };
  const target = parent.index + delta;
  if (target < 0 || target >= parent.array.length) return { definition: next, selectedPath: path };
  const owner = getNode(next, parent.path);
  if (owner.type === 'Switch') {
    const last = owner.children.length - 1;
    if (parent.index === last || target === last) return { definition: next, selectedPath: path };
    const [label] = owner.cases.splice(parent.index, 1);
    if (label !== undefined) owner.cases.splice(target, 0, label);
  }
  const [node] = parent.array.splice(parent.index, 1);
  if (!node) return { definition: next, selectedPath: path };
  parent.array.splice(target, 0, node);
  return { definition: next, selectedPath: childPath(parent.path, parent.key, target) };
}

export function canMove(definition: CaseDefinition, path: string): boolean {
  return Boolean(arrayParentFor(definition, path));
}

export function childSummary(node: TreeNode): string {
  if (isChildContainer(node)) return `${node.children.length} children`;
  if (node.type === 'SubTree') return node.id;
  if (node.type === 'RetryUntilSuccessful')
    return node.num_attempts === -1 ? '无限重试' : `最多 ${node.num_attempts} 次`;
  if (node.type === 'Repeat') return node.num_cycles === -1 ? '无限重复' : `${node.num_cycles} 轮`;
  if (node.type === 'Timeout' || node.type === 'Delay') return `${node.msec} ms`;
  if (WRAP_TYPES.has(node.type)) return node.type;
  return '';
}

function writeRoot(definition: CaseDefinition, root: TreeNode): CaseDefinition {
  return { ...definition, trees: { ...definition.trees, [definition.main]: root } };
}

function replaceNode(definition: CaseDefinition, path: string, node: TreeNode): EditResult {
  const next = clone(definition);
  const parent = arrayParentFor(next, path);
  if (!path) return { definition: writeRoot(next, node), selectedPath: '' };
  if (parent) {
    parent.array[parent.index] = node;
    return { definition: next, selectedPath: path };
  }
  const parts = path.split('.');
  const key = parts.pop();
  const owner = getNode(next, parts.join('.'));
  if (key && BRANCH_KEYS.has(key)) {
    const record = owner as unknown as Record<string, TreeNode>;
    record[key] = node;
  }
  return { definition: next, selectedPath: path };
}

function replaceSingleChild(definition: CaseDefinition, input: NodeInput, targetPath: string): EditResult {
  const key = targetPath.split('.').filter(Boolean).at(-1);
  if (key && BRANCH_KEYS.has(key)) {
    return replaceNode(definition, targetPath, makeNode(input));
  }
  const next = clone(definition);
  const selected = getNode(next, targetPath);
  const node = makeNode(input);
  if (WRAP_TYPES.has(selected.type) && 'child' in selected) {
    selected.child = node;
    return { definition: next, selectedPath: propPath(targetPath, 'child') };
  }
  return insertNode(definition, input, targetPath);
}

function arrayParentFor(
  definition: CaseDefinition,
  path: string,
): { path: string; key: 'children'; array: TreeNode[]; index: number } | null {
  const parts = path.split('.').filter(Boolean);
  if (parts.length < 2) return null;
  const index = Number(parts.at(-1));
  const key = parts.at(-2);
  if (key !== 'children' || !Number.isInteger(index)) return null;
  const parentPath = parts.slice(0, -2).join('.');
  const parent = getNode(definition, parentPath);
  const array = (parent as { children?: TreeNode[] }).children;
  if (!array) return null;
  return { path: parentPath, key, array, index };
}

function isChildContainer(node: TreeNode): node is Extract<TreeNode, { children: TreeNode[] }> {
  return CHILDREN_TYPES.has(node.type);
}

function ensureSwitchDefault(node: Extract<TreeNode, { type: 'Switch' }>): void {
  if (node.children.length === 0) {
    node.children.push({ type: 'Sequence', children: [] });
  }
}

function appendSwitchCase(
  definition: CaseDefinition,
  path: string,
  node: Extract<TreeNode, { type: 'Switch' }>,
  child: TreeNode,
): EditResult {
  ensureSwitchDefault(node);
  const defaultIndex = node.children.length - 1;
  node.cases.push('');
  node.children.splice(defaultIndex, 0, child);
  return { definition, selectedPath: childPath(path, 'children', defaultIndex) };
}

function isLeaf(node: TreeNode): node is LeafNode {
  return LEAF_TYPES.has(node.type);
}

function childPath(path: string, key: 'children', index: number): string {
  return path ? `${path}.${key}.${index}` : `${key}.${index}`;
}

function propPath(path: string, key: string): string {
  return path ? `${path}.${key}` : key;
}

function normalizeAttempt(value: number): number {
  const next = Math.floor(value);
  return next === -1 ? -1 : Math.max(1, next);
}

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function isWrapType(type: NodeType): boolean {
  return WRAP_TYPES.has(type);
}
