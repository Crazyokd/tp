import type { CatalogCapability, RuntimeLeaf } from '@tp/contract/adapter';
import { isTreeDocument, type CaseDefinition, type LeafNode, type NodeStatusResult, type TreeNode } from '@tp/contract';

export function leaf(type: 'Action' | 'Condition', capability: string, extra: Partial<LeafNode> = {}): LeafNode {
  return {
    type,
    adapter: extra.adapter ?? 'test',
    actor: extra.actor ?? 'robot',
    capability,
    ports: extra.ports ?? {},
    ...extra,
  };
}

export function caseDef(definition: TreeNode | CaseDefinition): CaseDefinition {
  if (isTreeDocument(definition)) return definition;
  return { main: 'Main', trees: { Main: definition } };
}

export async function testLeafAdapter(node: RuntimeLeaf): Promise<NodeStatusResult> {
  return {
    status: node.capability.includes('fail') ? 'FAILURE' : 'SUCCESS',
  };
}

export function leafCapabilities(
  definition: TreeNode | CaseDefinition,
  ports: CatalogCapability['ports'] = [],
): CatalogCapability[] {
  const document = caseDef(definition);
  const found = new Map<string, CatalogCapability>();
  const walk = (node: TreeNode) => {
    if (node.type === 'Action' || node.type === 'Condition') {
      found.set(`${node.adapter}::${node.capability}`, {
        adapter: node.adapter,
        key: node.capability,
        kind: node.type,
        label: node.capability,
        ports,
      });
    }
    if ('children' in node) node.children.forEach(walk);
    if ('child' in node) walk(node.child);
    if (node.type === 'IfThenElse' || node.type === 'WhileDoElse') {
      walk(node.if);
      walk(node.then);
      if (node.else) walk(node.else);
    }
    if (node.type === 'SubTree') {
      const target = document.trees[node.id];
      if (target) walk(target);
    }
  };
  for (const tree of Object.values(document.trees)) walk(tree);
  return [...found.values()];
}
