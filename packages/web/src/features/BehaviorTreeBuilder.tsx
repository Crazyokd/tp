import type { CaseDefinition } from '@tp/contract';
import type { DropMode, NodeInput } from '../domain/behavior-tree.ts';
import { BehaviorTreeGraph } from './BehaviorTreeGraph.tsx';

type Props = {
  definition: CaseDefinition;
  selectedPath: string;
  onSelect: (path: string) => void;
  onInsertNode: (input: NodeInput, targetPath: string, mode?: DropMode) => void;
};

export function BehaviorTreeBuilder({ definition, selectedPath, onSelect, onInsertNode }: Props) {
  return (
    <BehaviorTreeGraph
      definition={definition}
      mode="edit"
      selectedPath={selectedPath}
      onSelect={onSelect}
      onInsertNode={onInsertNode}
      fitViewKey="editor"
    />
  );
}
