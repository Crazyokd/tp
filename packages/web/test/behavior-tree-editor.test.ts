import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CaseDefinition, TreeNode } from '@tp/contract';
import {
  deleteNode,
  dropNode,
  getNode,
  makeNode,
  nodeInputFromTypeSelect,
  replaceNodeType,
  typeSelectValue,
  updateWrapper,
} from '../src/domain/behavior-tree.ts';
import {
  behaviorTreeStructuralKey,
  graphViewportOptions,
  layoutBehaviorTree,
  patchBehaviorTreeNodeData,
} from '../src/features/BehaviorTreeGraph.tsx';

function treeDoc(tree: TreeNode): CaseDefinition {
  return { main: 'Main', trees: { Main: tree } };
}

const graphDefinition: CaseDefinition = {
  main: 'Main',
  trees: {
    Main: {
      type: 'Sequence',
      children: [
        { type: 'Action', capability: 'test.first', adapter: 'test', actor: 'robot', ports: {} },
        {
          type: 'RetryUntilSuccessful',
          num_attempts: 2,
          child: { type: 'Condition', capability: 'test.second', adapter: 'test', actor: 'robot', ports: {} },
        },
      ],
    },
  },
};

test('shared graph layout is structurally identical in edit and run modes', () => {
  const edit = layoutBehaviorTree(graphDefinition, 'edit');
  const run = layoutBehaviorTree(graphDefinition, 'run');

  assert.deepEqual(
    edit.nodes.map(({ id, position }) => ({ id, position })),
    run.nodes.map(({ id, position }) => ({ id, position })),
  );
  assert.deepEqual(edit.edges, run.edges);
});

test('run viewport can fit wide trees while edit zoom remains usable', () => {
  assert.deepEqual(graphViewportOptions('edit'), { minZoom: 0.25, maxZoom: 1.8 });
  assert.deepEqual(graphViewportOptions('run'), { minZoom: 0.08, maxZoom: 1.8 });
});

test('run layout clears editor slots and insertion handlers', () => {
  const edit = layoutBehaviorTree(graphDefinition, 'edit');
  const run = layoutBehaviorTree(graphDefinition, 'run');
  const editableSequence = edit.nodes.find(({ id }) => id === 'root');

  assert.deepEqual(editableSequence?.data.slots, [{ label: 'then 3', mode: 'append', path: '' }]);
  for (const node of run.nodes) {
    assert.deepEqual(node.data.slots, []);
    assert.equal(node.data.onInsertNode, undefined);
  }
});

test('patching between edit and run modes replaces mode-specific node data', () => {
  const onInsertNode = () => undefined;
  const edit = patchBehaviorTreeNodeData(
    layoutBehaviorTree(graphDefinition, 'run'),
    graphDefinition,
    'edit',
    '',
    onInsertNode,
  );
  const run = patchBehaviorTreeNodeData(edit, graphDefinition, 'run');

  for (const node of run.nodes) {
    assert.equal(node.data.mode, 'run');
    assert.deepEqual(node.data.slots, []);
    assert.equal(node.data.onInsertNode, undefined);
  }

  const restoredEdit = patchBehaviorTreeNodeData(run, graphDefinition, 'edit', '', onInsertNode);
  const sequence = restoredEdit.nodes.find(({ id }) => id === 'root');
  assert.equal(sequence?.data.mode, 'edit');
  assert.deepEqual(sequence?.data.slots, [{ label: 'then 3', mode: 'append', path: '' }]);
  assert.strictEqual(sequence?.data.onInsertNode, onInsertNode);
});

test('metadata-only definition updates preserve structural layout positions', () => {
  const changedMetadata = treeDoc({
    type: 'Sequence',
    children: [
      {
        type: 'Action',
        capability: 'test.changed',
        adapter: 'test',
        actor: 'robot-2',
        ports: { speed: { literal: 2 } },
      },
      {
        type: 'RetryUntilSuccessful',
        num_attempts: 2,
        child: { type: 'Condition', capability: 'test.second', adapter: 'test', actor: 'robot', ports: {} },
      },
    ],
  });
  const initial = layoutBehaviorTree(graphDefinition, 'edit');
  const patched = patchBehaviorTreeNodeData(initial, changedMetadata, 'edit', 'children.0');

  assert.equal(behaviorTreeStructuralKey(graphDefinition), behaviorTreeStructuralKey(changedMetadata));
  assert.notEqual(
    behaviorTreeStructuralKey(graphDefinition),
    behaviorTreeStructuralKey(treeDoc({ type: 'Fallback', children: [] })),
  );
  for (const node of initial.nodes) {
    const updated = patched.nodes.find(({ id }) => id === node.id);
    assert.ok(updated);
    assert.strictEqual(updated.position, node.position);
    assert.deepEqual(updated.position, node.position);
  }
  assert.strictEqual(patched.edges, initial.edges);
  const changedLeaf = patched.nodes.find(({ id }) => id === 'children.0');
  assert.equal(changedLeaf?.data.meta, 'test.changed');
  assert.equal(changedLeaf?.selected, true);
  const changedRoot = changedMetadata.trees.Main;
  assert.deepEqual(
    changedLeaf?.data.definitionNode,
    changedRoot.type === 'Sequence' ? changedRoot.children[0] : undefined,
  );
});

test('layout and metadata patches keep explicit React Flow dimensions', () => {
  const layout = layoutBehaviorTree(graphDefinition, 'run');
  const patched = patchBehaviorTreeNodeData(layout, graphDefinition, 'run', '');

  for (const node of layout.nodes) {
    const updated = patched.nodes.find(({ id }) => id === node.id);
    assert.ok(updated);
    assert.equal(node.initialWidth, 240);
    assert.equal(node.initialHeight, 144);
    assert.equal(updated.initialWidth, node.initialWidth);
    assert.equal(updated.initialHeight, node.initialHeight);
    assert.strictEqual(updated.position, node.position);
  }
});

test('decorator drops wrap the target node without changing the wrapped child', () => {
  const initial = treeDoc({
    type: 'Sequence',
    children: [
      {
        type: 'Action',
        capability: 'demo.mapping.start',
        adapter: 'demo',
        actor: 'robot',
        ports: { mapName: { literal: 'editor-test' } },
      },
    ],
  });
  const root = initial.trees.Main;
  const originalChild = root.type === 'Sequence' ? root.children[0] : undefined;

  const result = dropNode(initial, 'RetryUntilSuccessful', 'children.0', 'wrap');
  const wrapped = getNode(result.definition, 'children.0');

  assert.equal(result.selectedPath, 'children.0');
  assert.equal(wrapped.type, 'RetryUntilSuccessful');
  if (wrapped.type !== 'RetryUntilSuccessful') return;
  assert.deepEqual(wrapped.child, originalChild);
  assert.equal(root.type === 'Sequence' && root.children[0]?.type, 'Action');
});

test('makeNode creates an Inverter around an empty Sequence', () => {
  assert.deepEqual(makeNode('Inverter'), {
    type: 'Inverter',
    child: { type: 'Sequence', children: [] },
  });
});

test('Inverter drops wrap the target node', () => {
  const initial = treeDoc({
    type: 'Sequence',
    children: [
      {
        type: 'Action',
        capability: 'demo.mapping.start',
        adapter: 'demo',
        actor: 'robot',
        ports: { mapName: { literal: 'invert-test' } },
      },
    ],
  });
  const root = initial.trees.Main;
  const originalChild = root.type === 'Sequence' ? root.children[0] : undefined;

  const result = dropNode(initial, 'Inverter', 'children.0', 'wrap');
  const wrapped = getNode(result.definition, 'children.0');

  assert.equal(result.selectedPath, 'children.0');
  assert.equal(wrapped.type, 'Inverter');
  if (wrapped.type !== 'Inverter') return;
  assert.deepEqual(wrapped.child, originalChild);
});

test('single child slots replace the decorator child', () => {
  const initial = treeDoc({
    type: 'Timeout',
    msec: 1000,
    child: { type: 'Condition', capability: 'demo.old', adapter: 'demo', actor: 'robot', ports: {} },
  });

  const result = dropNode(
    initial,
    { type: 'Action', capability: 'demo.mapping.drive_square', adapter: 'demo', actor: 'robot' },
    '',
    'replace-child',
  );

  assert.equal(result.selectedPath, 'child');
  assert.deepEqual(getNode(result.definition, 'child'), {
    type: 'Action',
    adapter: 'demo',
    actor: '',
    capability: 'demo.mapping.drive_square',
    ports: {},
  });
});

test('builder graph and editor reject a definition that is not a tree document', () => {
  const invalid = {
    type: 'Sequence',
    children: [{ type: 'Unknown', capability: 'demo.ready', ports: {} }],
  };

  assert.throws(() => layoutBehaviorTree(invalid as unknown as CaseDefinition, 'edit'), /tree document/);
  assert.throws(() => dropNode(invalid as unknown as CaseDefinition, 'Inverter', '', 'wrap'), /tree document/);
});

test('makeNode Switch includes a default child', () => {
  assert.deepEqual(makeNode('Switch'), {
    type: 'Switch',
    variable: 'state',
    cases: [],
    children: [{ type: 'Sequence', children: [] }],
  });
});

test('appending onto Switch inserts a case branch before the default child', () => {
  const initial = treeDoc(makeNode('Switch'));
  const result = dropNode(initial, { type: 'Action', capability: 'test.idle', adapter: 'test' }, '');
  const node = getNode(result.definition, '');

  assert.equal(node.type, 'Switch');
  if (node.type !== 'Switch') return;
  assert.equal(node.children.length, node.cases.length + 1);
  assert.equal(result.selectedPath, 'children.0');
  assert.equal(node.children[0]?.type, 'Action');
  assert.equal(node.children[1]?.type, 'Sequence');
});

test('deleting a Switch case removes the matching child and keeps the default', () => {
  const initial = treeDoc({
    type: 'Switch',
    variable: 'state',
    cases: ['idle', 'busy'],
    children: [
      { type: 'Action', capability: 'test.idle', adapter: 'test', actor: 'robot', ports: {} },
      { type: 'Action', capability: 'test.busy', adapter: 'test', actor: 'robot', ports: {} },
      { type: 'Sequence', children: [] },
    ],
  });

  const removed = deleteNode(initial, 'children.0');
  const node = getNode(removed.definition, '');
  assert.equal(node.type, 'Switch');
  if (node.type !== 'Switch') return;
  assert.deepEqual(node.cases, ['busy']);
  assert.equal(node.children.length, 2);
  assert.equal(node.children[0]?.type, 'Action');
  if (node.children[0]?.type === 'Action') assert.equal(node.children[0].capability, 'test.busy');
  assert.equal(node.children[1]?.type, 'Sequence');

  const blocked = deleteNode(removed.definition, 'children.1');
  const still = getNode(blocked.definition, '');
  assert.equal(still.type, 'Switch');
  if (still.type !== 'Switch') return;
  assert.equal(still.children.length, 2);
  assert.equal(still.children[1]?.type, 'Sequence');
});

test('ParallelAll updateWrapper writes max_failures', () => {
  const initial = treeDoc({ type: 'ParallelAll', children: [{ type: 'Sequence', children: [] }] });
  const result = updateWrapper(initial, '', { max_failures: 2 });
  const node = getNode(result.definition, '');
  assert.equal(node.type, 'ParallelAll');
  if (node.type !== 'ParallelAll') return;
  assert.equal(node.max_failures, 2);
});

test('Inverter child slot replaces the inverted subtree', () => {
  const initial = treeDoc({
    type: 'Inverter',
    child: { type: 'Condition', capability: 'demo.old', adapter: 'demo', actor: 'robot', ports: {} },
  });

  const result = dropNode(
    initial,
    { type: 'Action', capability: 'demo.mapping.drive_square', adapter: 'demo', actor: 'robot' },
    '',
    'replace-child',
  );

  assert.equal(result.selectedPath, 'child');
  assert.deepEqual(getNode(result.definition, 'child'), {
    type: 'Action',
    adapter: 'demo',
    actor: '',
    capability: 'demo.mapping.drive_square',
    ports: {},
  });
});

const catalog = [
  {
    adapter: 'demo',
    key: 'demo.mapping.start',
    kind: 'Action' as const,
    label: 'Start Mapping',
    ports: [],
  },
  {
    adapter: 'demo',
    key: 'demo.system.ready',
    kind: 'Condition' as const,
    label: 'System Ready',
    ports: [],
  },
];

test('type select can encode a catalog capability and replace a control node with that leaf', () => {
  const initial = treeDoc({ type: 'Sequence', children: [] });
  const value = 'leaf:demo::demo.mapping.start';
  const input = nodeInputFromTypeSelect(value, catalog);
  const result = replaceNodeType(initial, '', input);

  assert.deepEqual(input, {
    type: 'Action',
    adapter: 'demo',
    capability: 'demo.mapping.start',
  });
  assert.equal(typeSelectValue(getNode(result.definition, result.selectedPath)), value);
  assert.deepEqual(getNode(result.definition, result.selectedPath), {
    type: 'Action',
    adapter: 'demo',
    actor: '',
    capability: 'demo.mapping.start',
    ports: {},
  });
});

test('type select rejects an unknown adapter capability', () => {
  assert.throws(() => nodeInputFromTypeSelect('leaf:demo::missing.cap', catalog), /unknown capability/);
});
