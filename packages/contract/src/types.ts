export const controlNodeTypes = [
  'Sequence',
  'ReactiveSequence',
  'Fallback',
  'ReactiveFallback',
  'Parallel',
  'ParallelAll',
] as const;
export const leafNodeTypes = ['Action', 'Condition'] as const;
export const decoratorNodeTypes = [
  'RetryUntilSuccessful',
  'Repeat',
  'Timeout',
  'Inverter',
  'Delay',
  'ForceSuccess',
  'ForceFailure',
  'KeepRunningUntilFailure',
  'RunOnce',
  'IfThenElse',
  'WhileDoElse',
  'Switch',
  'SubTree',
] as const;
export const nodeTypes = [...controlNodeTypes, ...leafNodeTypes, ...decoratorNodeTypes] as const;

export type ControlNodeType = (typeof controlNodeTypes)[number];
export type LeafNodeType = (typeof leafNodeTypes)[number];
export type DecoratorNodeType = (typeof decoratorNodeTypes)[number];
export type NodeType = (typeof nodeTypes)[number];
export type NodeStatus = 'IDLE' | 'RUNNING' | 'SUCCESS' | 'FAILURE' | 'SKIPPED';

export type JsonObject = Record<string, unknown>;

export type NodePreconditions = {
  _skipIf?: string;
  _successIf?: string;
  _failureIf?: string;
};

export type PortBinding = { literal: unknown } | { key: string };

export type LeafNode = NodePreconditions & {
  type: LeafNodeType;
  adapter: string;
  actor: string;
  capability: string;
  ports?: Record<string, PortBinding>;
};

export type SequenceLikeNode = NodePreconditions & {
  type: 'Sequence' | 'ReactiveSequence' | 'Fallback' | 'ReactiveFallback';
  children: TreeNode[];
};

export type ParallelNode = NodePreconditions & {
  type: 'Parallel';
  children: TreeNode[];
  success_count?: number;
  failure_count?: number;
};

export type ParallelAllNode = NodePreconditions & {
  type: 'ParallelAll';
  children: TreeNode[];
  max_failures?: number;
};

export type ControlNode = SequenceLikeNode | ParallelNode | ParallelAllNode;

export type RetryUntilSuccessfulNode = NodePreconditions & {
  type: 'RetryUntilSuccessful';
  num_attempts: number;
  child: TreeNode;
};

export type RepeatNode = NodePreconditions & {
  type: 'Repeat';
  num_cycles: number;
  child: TreeNode;
};

export type TimeoutNode = NodePreconditions & {
  type: 'Timeout';
  msec: number;
  child: TreeNode;
};

export type DelayNode = NodePreconditions & {
  type: 'Delay';
  msec: number;
  child: TreeNode;
};

export type SingleChildDecoratorNode = NodePreconditions & {
  type: 'Inverter' | 'ForceSuccess' | 'ForceFailure' | 'KeepRunningUntilFailure' | 'RunOnce';
  child: TreeNode;
};

export type IfThenElseNode = NodePreconditions & {
  type: 'IfThenElse' | 'WhileDoElse';
  if: TreeNode;
  then: TreeNode;
  else?: TreeNode;
};

export type SwitchNode = NodePreconditions & {
  type: 'Switch';
  variable: string;
  cases: string[];
  children: TreeNode[];
};

export type SubTreeNode = NodePreconditions & {
  type: 'SubTree';
  id: string;
  remap?: Record<string, { key: string }>;
};

export type TreeNode =
  | LeafNode
  | ControlNode
  | RetryUntilSuccessfulNode
  | RepeatNode
  | TimeoutNode
  | DelayNode
  | SingleChildDecoratorNode
  | IfThenElseNode
  | SwitchNode
  | SubTreeNode;

export type CaseDefinition = {
  main: string;
  trees: Record<string, TreeNode>;
};

export type TestCase = {
  id: string;
  name: string;
  definition: CaseDefinition;
  createdAt: string;
  updatedAt: string;
};

export type RunStatus = 'queued' | 'running' | 'canceling' | 'passed' | 'failed' | 'canceled';
export type RunNodeStatus = 'pending' | 'running' | 'passed' | 'failed' | 'skipped' | 'canceled';

export type RunNodeAttempt = {
  attempt: number;
  status: 'running' | 'passed' | 'failed' | 'canceled' | 'skipped';
  startedAt: string;
  finishedAt: string | null;
  output?: JsonObject;
  error?: string;
};

type RunNodeState = {
  status: RunNodeStatus;
  attempts: RunNodeAttempt[];
};

export type RunLeafNode = NodePreconditions &
  RunNodeState & {
    type: LeafNodeType;
    adapter: string;
    actor: string;
    capability: string;
    ports?: Record<string, PortBinding>;
  };

export type RunSequenceLikeNode = NodePreconditions &
  RunNodeState & {
    type: 'Sequence' | 'ReactiveSequence' | 'Fallback' | 'ReactiveFallback';
    children: RunNode[];
  };

export type RunParallelNode = NodePreconditions &
  RunNodeState & {
    type: 'Parallel';
    children: RunNode[];
    success_count?: number;
    failure_count?: number;
  };

export type RunParallelAllNode = NodePreconditions &
  RunNodeState & {
    type: 'ParallelAll';
    children: RunNode[];
    max_failures?: number;
  };

export type RunControlNode = RunSequenceLikeNode | RunParallelNode | RunParallelAllNode;

export type RunRetryUntilSuccessfulNode = NodePreconditions &
  RunNodeState & {
    type: 'RetryUntilSuccessful';
    num_attempts: number;
    child: RunNode;
  };

export type RunRepeatNode = NodePreconditions &
  RunNodeState & {
    type: 'Repeat';
    num_cycles: number;
    child: RunNode;
  };

export type RunTimeoutNode = NodePreconditions &
  RunNodeState & {
    type: 'Timeout';
    msec: number;
    child: RunNode;
  };

export type RunDelayNode = NodePreconditions &
  RunNodeState & {
    type: 'Delay';
    msec: number;
    child: RunNode;
  };

export type RunSingleChildDecoratorNode = NodePreconditions &
  RunNodeState & {
    type: 'Inverter' | 'ForceSuccess' | 'ForceFailure' | 'KeepRunningUntilFailure' | 'RunOnce';
    child: RunNode;
  };

export type RunIfThenElseNode = NodePreconditions &
  RunNodeState & {
    type: 'IfThenElse' | 'WhileDoElse';
    if: RunNode;
    then: RunNode;
    else?: RunNode;
  };

export type RunSwitchNode = NodePreconditions &
  RunNodeState & {
    type: 'Switch';
    variable: string;
    cases: string[];
    children: RunNode[];
  };

export type RunSubTreeNode = NodePreconditions &
  RunNodeState & {
    type: 'SubTree';
    id: string;
    remap?: Record<string, { key: string }>;
  };

export type RunNode =
  | RunLeafNode
  | RunControlNode
  | RunRetryUntilSuccessfulNode
  | RunRepeatNode
  | RunTimeoutNode
  | RunDelayNode
  | RunSingleChildDecoratorNode
  | RunIfThenElseNode
  | RunSwitchNode
  | RunSubTreeNode;

export type RunNodeProgressEvent =
  | {
      revision: number;
      kind: 'started';
      path: string;
      nodeType: NodeType;
      attempt: number;
      timestamp: string;
      capability?: string;
      actor?: string | null;
    }
  | {
      revision: number;
      kind: 'finished';
      path: string;
      nodeType: NodeType;
      attempt: number;
      timestamp: string;
      status: 'passed' | 'failed' | 'canceled' | 'skipped';
      output?: JsonObject;
      error?: string;
    };

export type Artifact = {
  id: string;
  name: string;
  mediaType: string;
};

export type Run = {
  id: string;
  caseId: string;
  status: RunStatus;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  revision: number;
  tree: {
    main: string;
    trees: Record<string, RunNode>;
  };
  artifacts: Artifact[];
  error?: string;
};

export type LiveRun = Run & { definition: CaseDefinition };

export type WorkerSlotState = 'starting' | 'idle' | 'running' | 'finalizing' | 'failed';

export type WorkerSlot = {
  id: string;
  state: WorkerSlotState;
  runId: string | null;
};

export type TickResult = {
  status: 'RUNNING' | 'SUCCESS' | 'FAILURE';
  output?: JsonObject;
};

export type NodeStatusResult = TickResult;

export type TreeExecutionResult = {
  status: 'passed' | 'failed' | 'canceled';
};
