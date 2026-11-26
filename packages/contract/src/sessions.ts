import type { CaseDefinition, SessionBinding, TreeNode } from './types.ts';

export function collectLeafSessions(trees: Record<string, TreeNode>): Array<{ adapter: string; actor: string }> {
  const seen = new Map<string, { adapter: string; actor: string }>();
  for (const tree of Object.values(trees)) walk(tree, seen);
  return [...seen.values()];
}

export function sessionsForLeaves(trees: Record<string, TreeNode>): SessionBinding[] {
  return collectLeafSessions(trees).map((pair) => ({ ...pair, ports: {} }));
}

export function withLeafSessions(
  definition: Omit<CaseDefinition, 'sessions'> & { sessions?: SessionBinding[] },
): CaseDefinition {
  return {
    ...definition,
    sessions: definition.sessions ?? sessionsForLeaves(definition.trees),
  };
}

function walk(definition: TreeNode, seen: Map<string, { adapter: string; actor: string }>): void {
  if ('capability' in definition) {
    const key = `${definition.adapter}\0${definition.actor}`;
    if (!seen.has(key)) seen.set(key, { adapter: definition.adapter, actor: definition.actor });
    return;
  }
  if ('children' in definition) {
    definition.children.forEach((child) => walk(child, seen));
    return;
  }
  if ('if' in definition) {
    walk(definition.if, seen);
    walk(definition.then, seen);
    if (definition.else) walk(definition.else, seen);
    return;
  }
  if ('child' in definition) walk(definition.child, seen);
}
