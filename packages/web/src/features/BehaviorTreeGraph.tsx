import Dagre from '@dagrejs/dagre';
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';

import { requireCaseDefinition, type CaseDefinition, type NodeType, type TreeNode } from '@tp/contract';
import {
  CHILDREN_TYPES,
  isWrapType,
  LEAF_TYPES,
  type DropMode,
  type NodeInput,
  type NodeTemplate,
} from '../domain/behavior-tree.ts';

export type BehaviorTreeGraphMode = 'edit' | 'run';

export type NodePresentation = {
  status?: string;
  statusLabel?: string;
  detail?: string;
  duration?: string;
  attempt?: number;
  edgeClass?: string;
  pathClass?: string;
};

export type BehaviorTreeGraphProps = {
  definition: CaseDefinition;
  mode: BehaviorTreeGraphMode;
  selectedPath: string;
  onSelect: (path: string) => void;
  onInsertNode?: (input: NodeInput, targetPath: string, mode?: DropMode) => void;
  nodePresentation?: (path: string, node: TreeNode) => NodePresentation;
  fitViewKey: string;
};

type BtSlot = {
  label: string;
  mode: DropMode;
  path: string;
};

type BehaviorTreeNodeData = {
  path: string;
  label: string;
  type: NodeType;
  meta: string;
  kind: string;
  definitionNode: TreeNode;
  mode: BehaviorTreeGraphMode;
  slots: BtSlot[];
  onInsertNode?: (input: NodeInput, targetPath: string, mode?: DropMode) => void;
  presentation?: NodePresentation;
};

export type BehaviorTreeFlowNode = Node<BehaviorTreeNodeData, 'bt'>;

export type BehaviorTreeLayout = {
  nodes: BehaviorTreeFlowNode[];
  edges: Edge[];
};

type StructuralNodeData = Omit<BehaviorTreeNodeData, 'mode' | 'slots' | 'onInsertNode' | 'presentation'>;
type StructuralFlowNode = Node<StructuralNodeData, 'bt'>;
type StructuralLayout = {
  nodes: StructuralFlowNode[];
  edges: Edge[];
};
type OptionalNodePresentation = (path: string, node: TreeNode) => NodePresentation | undefined;

const NODE_WIDTH = 240;
const NODE_HEIGHT = 144;

const nodeTypes = {
  bt: BehaviorTreeNode,
};

function createLayoutGraph() {
  const graph = new Dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}));
  graph.setGraph({ rankdir: 'TB', nodesep: 54, ranksep: 96 });
  return graph;
}

type LayoutGraph = ReturnType<typeof createLayoutGraph>;

export function BehaviorTreeGraph(props: BehaviorTreeGraphProps) {
  return (
    <ReactFlowProvider>
      <BehaviorTreeFlow {...props} />
    </ReactFlowProvider>
  );
}

function BehaviorTreeFlow({
  definition,
  mode,
  selectedPath,
  onSelect,
  onInsertNode,
  nodePresentation,
  fitViewKey,
}: BehaviorTreeGraphProps) {
  const structuralKey = behaviorTreeStructuralKey(definition);
  const structure = useMemo(() => layoutStructure(definition), [structuralKey]);
  const elements = useMemo(
    () => presentLayout(structure, definition, mode, selectedPath, onInsertNode, nodePresentation),
    [definition, mode, nodePresentation, onInsertNode, selectedPath, structure],
  );
  const { fitView } = useReactFlow();
  const fitViewRef = useRef(fitView);
  const viewportOptions = graphViewportOptions(mode);

  useEffect(() => {
    fitViewRef.current = fitView;
  }, [fitView]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => fitViewRef.current({ padding: 0.22, duration: 180 }));
    return () => cancelAnimationFrame(frame);
  }, [fitViewKey, structuralKey]);

  const flow = (
    <ReactFlow
      nodes={elements.nodes}
      edges={elements.edges}
      nodeTypes={nodeTypes}
      onNodeClick={(_, node) => onSelect(node.data.path)}
      minZoom={viewportOptions.minZoom}
      maxZoom={viewportOptions.maxZoom}
      nodesDraggable={false}
      nodesConnectable={false}
      proOptions={{ hideAttribution: true }}
    >
      <Background gap={28} size={1} color="#dfe5ee" />
      <Controls showInteractive={false} />
      <MiniMap pannable zoomable nodeStrokeWidth={3} />
    </ReactFlow>
  );

  if (mode === 'edit') {
    return (
      <EditableCanvas selectedPath={selectedPath} onInsertNode={onInsertNode}>
        {flow}
      </EditableCanvas>
    );
  }
  return <ReadOnlyCanvas>{flow}</ReadOnlyCanvas>;
}

function EditableCanvas({
  selectedPath,
  onInsertNode,
  children,
}: {
  selectedPath: string;
  onInsertNode?: BehaviorTreeGraphProps['onInsertNode'];
  children: ReactNode;
}) {
  const [dragging, setDragging] = useState(false);

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    const input = nodeInputFromEvent(event);
    if (!input || !onInsertNode) return;
    onInsertNode(input, pathFromEventTarget(event.target) ?? selectedPath);
  }

  return (
    <div
      className={`flow-canvas ${dragging ? 'dragging' : ''}`}
      data-testid="tree-canvas"
      onDragLeave={() => setDragging(false)}
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
        setDragging(true);
      }}
      onDrop={handleDrop}
    >
      {children}
    </div>
  );
}

function ReadOnlyCanvas({ children }: { children: ReactNode }) {
  return (
    <div className="flow-canvas" data-testid="tree-canvas">
      {children}
    </div>
  );
}

function BehaviorTreeNode(props: NodeProps<BehaviorTreeFlowNode>) {
  if (props.data.mode === 'edit') return <EditableBehaviorTreeNode {...props} />;
  return <ReadOnlyBehaviorTreeNode {...props} />;
}

function EditableBehaviorTreeNode({ data, selected }: NodeProps<BehaviorTreeFlowNode>) {
  const [dropTarget, setDropTarget] = useState(false);

  function insertFromDrop(event: DragEvent<HTMLDivElement>, targetPath = data.path, mode?: DropMode) {
    event.preventDefault();
    event.stopPropagation();
    setDropTarget(false);
    const input = nodeInputFromEvent(event);
    if (!input || !data.onInsertNode) return;
    data.onInsertNode(input, targetPath, mode ?? bodyDropMode(input.type));
  }

  return (
    <NodeShell
      data={data}
      selected={selected}
      dropTarget={dropTarget}
      onDragEnter={(event) => {
        event.preventDefault();
        event.stopPropagation();
        setDropTarget(true);
      }}
      onDragOver={(event) => {
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = 'copy';
      }}
      onDragLeave={(event) => {
        const next = event.relatedTarget;
        if (!(next instanceof Element) || !event.currentTarget.contains(next)) setDropTarget(false);
      }}
      onDrop={insertFromDrop}
    >
      <NodeContent data={data} />
      {data.slots && data.slots.length > 0 && (
        <div className="bt-slots">
          {data.slots.map((slot) => (
            <div
              className="bt-slot"
              data-testid="bt-slot"
              data-bt-slot-mode={slot.mode}
              data-bt-slot-path={slot.path}
              key={`${slot.mode}-${slot.label}`}
              onDragOver={(event) => {
                event.preventDefault();
                event.stopPropagation();
                event.dataTransfer.dropEffect = 'copy';
              }}
              onDrop={(event) => insertFromDrop(event, slot.path, slot.mode)}
            >
              {slot.label}
            </div>
          ))}
        </div>
      )}
    </NodeShell>
  );
}

function ReadOnlyBehaviorTreeNode({ data, selected }: NodeProps<BehaviorTreeFlowNode>) {
  return (
    <NodeShell data={data} selected={selected} dropTarget={false}>
      <NodeContent data={data} />
    </NodeShell>
  );
}

function NodeShell({
  data,
  selected,
  dropTarget,
  children,
  onDragEnter,
  onDragOver,
  onDragLeave,
  onDrop,
}: {
  data: BehaviorTreeNodeData;
  selected: boolean;
  dropTarget: boolean;
  children: ReactNode;
  onDragEnter?: (event: DragEvent<HTMLDivElement>) => void;
  onDragOver?: (event: DragEvent<HTMLDivElement>) => void;
  onDragLeave?: (event: DragEvent<HTMLDivElement>) => void;
  onDrop?: (event: DragEvent<HTMLDivElement>) => void;
}) {
  const statusClass = data.presentation?.status ? ` status-${data.presentation.status}` : '';
  const pathClass = data.presentation?.pathClass ? ` ${data.presentation.pathClass}` : '';
  return (
    <div
      className={`bt-flow-node ${selected ? 'selected' : ''} ${data.kind} ${dropTarget ? 'drop-target' : ''}${statusClass}${pathClass}`}
      data-testid="bt-node"
      data-bt-path={data.path}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {data.path && <Handle className="bt-handle in" type="target" position={Position.Top} />}
      {children}
      {!LEAF_TYPES.has(data.type) && <Handle className="bt-handle out" type="source" position={Position.Bottom} />}
    </div>
  );
}

function NodeContent({ data }: { data: BehaviorTreeNodeData }) {
  const presentation = data.presentation;
  return (
    <>
      <div className="bt-flow-head">
        <span className="bt-flow-badge">{badgeFor(data.type)}</span>
        <span>{data.label}</span>
        {presentation?.statusLabel && <span aria-label={presentation.statusLabel}>{presentation.statusLabel}</span>}
      </div>
      <div className="bt-flow-label">{data.type}</div>
      <div className="bt-flow-meta">{presentation?.detail ?? data.meta}</div>
      {(presentation?.duration || presentation?.attempt !== undefined) && (
        <div>
          {presentation.duration}
          {presentation.attempt !== undefined && ` · 第 ${presentation.attempt} 次`}
        </div>
      )}
    </>
  );
}

export function layoutBehaviorTree(definition: CaseDefinition, mode: BehaviorTreeGraphMode): BehaviorTreeLayout {
  return presentLayout(layoutStructure(definition), definition, mode, '', undefined, undefined);
}

export function graphViewportOptions(mode: BehaviorTreeGraphMode): { minZoom: number; maxZoom: number } {
  return {
    minZoom: mode === 'run' ? 0.08 : 0.25,
    maxZoom: 1.8,
  };
}

export function behaviorTreeStructuralKey(definition: CaseDefinition): string {
  const structure: Array<[path: string, type: NodeType]> = [];
  visitDefinition(graphRoot(definition), '', graphTrees(definition), (node, path) => structure.push([path, node.type]));
  return JSON.stringify(structure);
}

export function patchBehaviorTreeNodeData(
  layout: BehaviorTreeLayout,
  definition: CaseDefinition,
  mode: BehaviorTreeGraphMode,
  selectedPath = '',
  onInsertNode?: BehaviorTreeGraphProps['onInsertNode'],
): BehaviorTreeLayout {
  return {
    nodes: patchNodeData(layout.nodes, definition, mode, selectedPath, onInsertNode, undefined),
    edges: layout.edges,
  };
}

function layoutStructure(definition: CaseDefinition): StructuralLayout {
  const graph = createLayoutGraph();
  const nodes: StructuralFlowNode[] = [];
  const edges: Edge[] = [];
  const document = graphDocument(definition);
  addFlowElements(document.trees[document.main]!, '', document.main, null, '', nodes, edges, graph, document.trees, []);
  Dagre.layout(graph);

  return {
    nodes: nodes.map((node) => {
      const position = graph.node(node.id) as { x: number; y: number };
      return { ...node, position: { x: position.x - NODE_WIDTH / 2, y: position.y - NODE_HEIGHT / 2 } };
    }),
    edges,
  };
}

function presentLayout(
  structure: StructuralLayout,
  definition: CaseDefinition,
  mode: BehaviorTreeGraphMode,
  selectedPath: string,
  onInsertNode: BehaviorTreeGraphProps['onInsertNode'],
  nodePresentation: BehaviorTreeGraphProps['nodePresentation'],
): BehaviorTreeLayout {
  const presentationByPath = new Map<string, NodePresentation>();
  const nodes = patchNodeData(structure.nodes, definition, mode, selectedPath, onInsertNode, (path, node) => {
    const presentation = nodePresentation?.(path, node);
    if (presentation) presentationByPath.set(path, presentation);
    return presentation;
  });
  const edges = structure.edges.map((edge) => {
    const extraClass = presentationByPath.get(edge.target)?.edgeClass;
    return extraClass ? { ...edge, className: `${edge.className ?? ''} ${extraClass}`.trim() } : edge;
  });
  return { nodes, edges };
}

function patchNodeData(
  nodes: StructuralFlowNode[] | BehaviorTreeFlowNode[],
  definition: CaseDefinition,
  mode: BehaviorTreeGraphMode,
  selectedPath: string,
  onInsertNode: BehaviorTreeGraphProps['onInsertNode'],
  nodePresentation: OptionalNodePresentation | undefined,
): BehaviorTreeFlowNode[] {
  const definitions = definitionNodesByPath(definition);
  return nodes.map((node): BehaviorTreeFlowNode => {
    const definitionNode = definitions.get(node.data.path);
    if (!definitionNode || definitionNode.type !== node.data.type) {
      throw new Error(`behavior tree structure changed at ${node.data.path || 'root'}`);
    }
    const presentation = nodePresentation?.(node.data.path, definitionNode);
    return {
      ...node,
      selected: node.data.path === selectedPath,
      data: {
        path: node.data.path,
        label: node.data.label,
        type: definitionNode.type,
        meta: nodeMeta(definitionNode),
        kind: nodeKind(definitionNode),
        definitionNode,
        mode,
        slots: mode === 'edit' ? slotsFor(definitionNode, node.data.path) : [],
        onInsertNode: mode === 'edit' ? onInsertNode : undefined,
        presentation,
      },
    };
  });
}

function addFlowElements(
  node: TreeNode,
  path: string,
  label: string,
  parentId: string | null,
  edgeLabel: string,
  nodes: StructuralFlowNode[],
  edges: Edge[],
  graph: LayoutGraph,
  trees: Record<string, TreeNode>,
  stack: string[],
) {
  const id = path || 'root';
  graph.setNode(id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  nodes.push({
    id,
    type: 'bt',
    position: { x: 0, y: 0 },
    initialWidth: NODE_WIDTH,
    initialHeight: NODE_HEIGHT,
    data: {
      path,
      label,
      type: node.type,
      meta: nodeMeta(node),
      kind: nodeKind(node),
      definitionNode: node,
    },
  });
  if (parentId) {
    graph.setEdge(parentId, id);
    edges.push({
      id: `${parentId}-${id}`,
      source: parentId,
      target: id,
      label: edgeLabel,
      type: 'smoothstep',
      className: `bt-edge bt-edge-${edgeClass(edgeLabel)}`,
      markerEnd: { type: MarkerType.ArrowClosed },
    });
  }

  const next = (child: TreeNode, childPathValue: string, childLabel: string, childEdge: string) =>
    addFlowElements(child, childPathValue, childLabel, id, childEdge, nodes, edges, graph, trees, stack);

  if (isComposite(node)) {
    node.children
      .map((child, index) => ({ child, index }))
      .reverse()
      .forEach(({ child, index }) =>
        next(child, childPath(path, 'children', index), `child ${index + 1}`, childEdgeLabel(node.type, index)),
      );
  } else if (node.type === 'IfThenElse' || node.type === 'WhileDoElse') {
    next(node.if, propPath(path, 'if'), 'if', 'if');
    next(node.then, propPath(path, 'then'), 'then', 'then');
    if (node.else) next(node.else, propPath(path, 'else'), 'else', 'else');
  } else if (node.type === 'SubTree') {
    if (stack.includes(node.id)) return;
    const target = trees[node.id];
    if (target)
      addFlowElements(target, propPath(path, 'tree'), node.id, id, 'tree', nodes, edges, graph, trees, [
        ...stack,
        node.id,
      ]);
  } else if ('child' in node) {
    next(node.child, propPath(path, 'child'), 'child', 'child');
  }
}

function definitionNodesByPath(definition: CaseDefinition): Map<string, TreeNode> {
  const nodes = new Map<string, TreeNode>();
  visitDefinition(graphRoot(definition), '', graphTrees(definition), (node, path) => nodes.set(path, node));
  return nodes;
}

function visitDefinition(
  node: TreeNode,
  path: string,
  trees: Record<string, TreeNode>,
  visit: (node: TreeNode, path: string) => void,
  stack: string[] = [],
) {
  visit(node, path);
  if (isComposite(node)) {
    node.children.forEach((child, index) =>
      visitDefinition(child, childPath(path, 'children', index), trees, visit, stack),
    );
  } else if (node.type === 'IfThenElse' || node.type === 'WhileDoElse') {
    visitDefinition(node.if, propPath(path, 'if'), trees, visit, stack);
    visitDefinition(node.then, propPath(path, 'then'), trees, visit, stack);
    if (node.else) visitDefinition(node.else, propPath(path, 'else'), trees, visit, stack);
  } else if (node.type === 'SubTree') {
    if (stack.includes(node.id)) return;
    const target = trees[node.id];
    if (target) visitDefinition(target, propPath(path, 'tree'), trees, visit, [...stack, node.id]);
  } else if ('child' in node) {
    visitDefinition(node.child, propPath(path, 'child'), trees, visit, stack);
  }
}

function graphDocument(definition: CaseDefinition): CaseDefinition {
  return requireCaseDefinition(definition);
}

function graphRoot(definition: CaseDefinition): TreeNode {
  const document = graphDocument(definition);
  return document.trees[document.main]!;
}

function graphTrees(definition: CaseDefinition): Record<string, TreeNode> {
  return graphDocument(definition).trees;
}

function nodeInputFromEvent(event: DragEvent): NodeTemplate | null {
  const raw = event.dataTransfer.getData('application/tp-node');
  if (!raw) return null;
  if (!raw.startsWith('{')) return { type: raw as NodeType };
  try {
    const input = JSON.parse(raw) as Partial<NodeTemplate>;
    return typeof input.type === 'string' ? (input as NodeTemplate) : null;
  } catch {
    return null;
  }
}

function pathFromEventTarget(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null;
  return target.closest<HTMLElement>('[data-bt-path]')?.dataset.btPath ?? null;
}

function bodyDropMode(type: NodeType): DropMode {
  return isWrapType(type) ? 'wrap' : 'auto';
}

function slotsFor(node: TreeNode, path: string): BtSlot[] {
  if (node.type === 'Sequence' || node.type === 'ReactiveSequence') {
    return [{ label: `then ${node.children.length + 1}`, mode: 'append', path }];
  }
  if (node.type === 'Fallback' || node.type === 'ReactiveFallback') {
    return [{ label: `fallback ${node.children.length + 1}`, mode: 'append', path }];
  }
  if (node.type === 'Parallel' || node.type === 'ParallelAll' || node.type === 'Switch') {
    return [{ label: `branch ${node.children.length + 1}`, mode: 'append', path }];
  }
  if (isWrapType(node.type)) return [{ label: 'child', mode: 'replace-child', path }];
  if (node.type === 'IfThenElse' || node.type === 'WhileDoElse') {
    return [
      { label: 'if', mode: 'replace-child', path: propPath(path, 'if') },
      { label: 'then', mode: 'replace-child', path: propPath(path, 'then') },
      { label: 'else', mode: 'replace-child', path: propPath(path, 'else') },
    ];
  }
  return [];
}

function nodeMeta(node: TreeNode): string {
  if ('capability' in node) return node.capability;
  if (node.type === 'Sequence' || node.type === 'ReactiveSequence') return `${node.children.length} ordered steps`;
  if (node.type === 'Fallback' || node.type === 'ReactiveFallback') return `${node.children.length} fallback branches`;
  if (node.type === 'Parallel' || node.type === 'ParallelAll') return `${node.children.length} parallel branches`;
  if (node.type === 'Switch') return node.variable;
  if (node.type === 'SubTree') return node.id;
  if (node.type === 'RetryUntilSuccessful')
    return node.num_attempts === -1 ? '无限重试' : `最多 ${node.num_attempts} 次`;
  if (node.type === 'Repeat') return node.num_cycles === -1 ? '无限重复' : `${node.num_cycles} 轮`;
  if (node.type === 'Timeout' || node.type === 'Delay') return `${node.msec} ms`;
  if (isWrapType(node.type)) return node.type;
  return '';
}

function nodeKind(node: TreeNode): string {
  if (LEAF_TYPES.has(node.type)) return 'leaf';
  if (isWrapType(node.type) || node.type === 'IfThenElse' || node.type === 'WhileDoElse' || node.type === 'SubTree')
    return 'decorator';
  return node.type === 'Parallel' || node.type === 'ParallelAll' ? 'parallel' : 'control';
}

function badgeFor(type: NodeType): string {
  const badges: Partial<Record<NodeType, string>> = {
    Action: 'ACT',
    Condition: 'IF',
    Delay: 'DLY',
    Fallback: 'FB',
    ForceFailure: 'FF',
    ForceSuccess: 'FS',
    IfThenElse: 'ITE',
    KeepRunningUntilFailure: 'KR',
    Parallel: 'PAR',
    ParallelAll: 'ALL',
    ReactiveFallback: 'RFB',
    ReactiveSequence: 'RSEQ',
    Repeat: 'REP',
    RetryUntilSuccessful: 'RETRY',
    RunOnce: 'ONCE',
    Sequence: 'SEQ',
    SubTree: 'SUB',
    Switch: 'SW',
    Timeout: 'TIME',
    Inverter: 'INV',
    WhileDoElse: 'WDE',
  };
  return badges[type] ?? type.slice(0, 4).toUpperCase();
}

function childEdgeLabel(type: TreeNode['type'], index: number): string {
  if (type === 'Sequence' || type === 'ReactiveSequence') return `then ${index + 1}`;
  if (type === 'Fallback' || type === 'ReactiveFallback') return index === 0 ? 'try 1' : `fallback ${index + 1}`;
  return 'parallel';
}

function isComposite(node: TreeNode): node is Extract<TreeNode, { children: TreeNode[] }> {
  return CHILDREN_TYPES.has(node.type);
}

function edgeClass(label: string): string {
  if (label.startsWith('then')) return 'sequence';
  if (label.startsWith('try') || label.startsWith('fallback')) return 'selector';
  return label.replace(/\s+/g, '-').toLowerCase();
}

export function childPath(path: string, key: 'children', index: number): string {
  return path ? `${path}.${key}.${index}` : `${key}.${index}`;
}

export function propPath(path: string, key: 'child' | 'if' | 'then' | 'else' | 'tree'): string {
  return path ? `${path}.${key}` : key;
}
