import { Play, Plus, Save, Trash2 } from 'lucide-react';
import { type DragEvent, type FormEvent, useState } from 'react';

import type { CatalogCapability, PortDefinition } from '@tp/contract';
import type { CaseDefinition, LeafNode, NodeType, PortBinding, SessionBinding, TreeNode } from '@tp/contract';
import type { HttpAdapter } from '../api/client.ts';
import {
  canMove,
  LEAF_TYPES,
  nodeInputFromTypeSelect,
  typeSelectValue,
  type DropMode,
  type NodeInput,
} from '../domain/behavior-tree.ts';
import { highlightJson } from '../domain/json-highlight.ts';
import { BehaviorTreeBuilder } from './BehaviorTreeBuilder.tsx';

const PALETTE_GROUPS: { title: string; types: NodeType[] }[] = [
  {
    title: 'Control',
    types: ['Sequence', 'ReactiveSequence', 'Fallback', 'ReactiveFallback', 'Parallel', 'ParallelAll'],
  },
  {
    title: 'Decorator',
    types: [
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
    ],
  },
];

const NODE_HINTS: Record<NodeType, string> = {
  Action: 'do',
  Condition: 'check',
  Delay: 'wait then child',
  Fallback: 'first success',
  ForceFailure: 'force fail',
  ForceSuccess: 'force pass',
  IfThenElse: 'if / then / else',
  KeepRunningUntilFailure: 'loop until fail',
  Parallel: 'threshold parallel',
  ParallelAll: 'all branches',
  ReactiveFallback: 'recheck fallback',
  ReactiveSequence: 'recheck sequence',
  Repeat: 'repeat cycles',
  RetryUntilSuccessful: 'retry failures',
  RunOnce: 'cache first result',
  Sequence: 'then order',
  SubTree: 'named tree',
  Switch: 'blackboard switch',
  Timeout: 'wrap timeout',
  Inverter: 'invert child',
  WhileDoElse: 'while / do / else',
};

type Props = {
  caseName: string;
  caseDescription: string;
  adapters: readonly HttpAdapter[];
  capabilities: readonly CatalogCapability[];
  definition: CaseDefinition;
  definitionText: string;
  selected: TreeNode;
  selectedPath: string;
  status: string;
  onAddNode: (input: NodeInput, path?: string, mode?: DropMode) => void;
  onCaseNameChange: (name: string) => void;
  onCaseDescriptionChange: (description: string) => void;
  onCreate: () => void;
  onDeleteNode: () => void;
  onMoveNode: (delta: -1 | 1) => void;
  onReplaceType: (input: NodeInput) => void;
  onSave: (event?: FormEvent) => void;
  onSelect: (path: string) => void;
  onStartRun: () => void;
  onUpdateLeaf: (
    input: Partial<{ adapter: string; capability: string; actor: string; ports: Record<string, PortBinding> }>,
  ) => void;
  onUpdateNumber: (
    field: 'num_attempts' | 'num_cycles' | 'msec' | 'success_count' | 'failure_count' | 'max_failures',
    value: string,
  ) => void;
  onUpdateVariable?: (value: string) => void;
  onUpdateSwitchCase?: (index: number, value: string) => void;
  onRemoveSwitchCase?: (index: number) => void;
  onUpdateSessions: (sessions: SessionBinding[]) => void;
};

export function BuilderPage({
  caseName,
  caseDescription,
  adapters,
  capabilities,
  definition,
  definitionText,
  selected,
  selectedPath,
  status,
  onAddNode,
  onCaseNameChange,
  onCaseDescriptionChange,
  onCreate,
  onDeleteNode,
  onMoveNode,
  onReplaceType,
  onSave,
  onSelect,
  onStartRun,
  onUpdateLeaf,
  onUpdateNumber,
  onUpdateVariable,
  onUpdateSwitchCase,
  onRemoveSwitchCase,
  onUpdateSessions,
}: Props) {
  const [centerView, setCenterView] = useState<'canvas' | 'json'>('canvas');
  const [selectedSession, setSelectedSession] = useState(0);

  return (
    <section className="editor" data-testid="builder-page">
      <div className="section-head">
        <div>
          <h2>Behavior Tree Case Builder</h2>
          <div className="meta">可视化编排 Case definition，保存后即可发起 Run。</div>
        </div>
        <span className="status">{status}</span>
      </div>

      <form data-testid="case-form" className="case-bar" onSubmit={onSave}>
        <label>
          Case 名称
          <input
            data-testid="case-name"
            name="name"
            autoComplete="off"
            required
            value={caseName}
            onChange={(event) => onCaseNameChange(event.target.value)}
          />
        </label>
        <label>
          描述
          <input
            data-testid="case-description"
            name="description"
            autoComplete="off"
            required
            value={caseDescription}
            onChange={(event) => onCaseDescriptionChange(event.target.value)}
          />
        </label>
        <div className="toolbar form-actions">
          <button data-testid="save-case" className="primary" type="submit">
            <Save size={16} />
            保存 Case
          </button>
          <button data-testid="start-run" type="button" onClick={onStartRun}>
            <Play size={16} />
            创建 Run
          </button>
          <button type="button" onClick={onCreate}>
            <Plus size={16} />
            新建
          </button>
        </div>
      </form>

      <div className="builder" data-testid="bt-editor">
        <aside className="palette" data-testid="drag-palette">
          <h3>节点</h3>
          {PALETTE_GROUPS.map((group) => (
            <div className="palette-group" key={group.title}>
              <div className="palette-title">{group.title}</div>
              {group.types.map((type) => (
                <button
                  className="palette-node"
                  key={type}
                  type="button"
                  data-node-type={type}
                  draggable
                  onDragStart={(event: DragEvent<HTMLButtonElement>) =>
                    event.dataTransfer.setData('application/tp-node', JSON.stringify({ type }))
                  }
                >
                  <span>{type}</span>
                  <small>{NODE_HINTS[type]}</small>
                </button>
              ))}
            </div>
          ))}
          <div className="palette-group" data-testid="capability-palette">
            <div className="palette-title">Capabilities</div>
            {capabilities.map((capability) => (
              <button
                className="palette-node"
                key={`${capability.adapter}::${capability.key}`}
                type="button"
                data-capability={capability.key}
                data-adapter={capability.adapter}
                draggable
                onDragStart={(event: DragEvent<HTMLButtonElement>) =>
                  event.dataTransfer.setData(
                    'application/tp-node',
                    JSON.stringify({ type: capability.kind, adapter: capability.adapter, capability: capability.key }),
                  )
                }
              >
                <span>{capability.label}</span>
                <small>
                  {capability.adapter}/{capability.key}
                </small>
              </button>
            ))}
          </div>
        </aside>

        <section className="tree-panel">
          <div className="section-head tight">
            <h3>Tree</h3>
            <span className="view-switch" role="radiogroup" aria-label="中间视图" data-testid="builder-view">
              <button
                type="button"
                role="radio"
                aria-checked={centerView === 'canvas'}
                data-testid="builder-view-canvas"
                onClick={() => setCenterView('canvas')}
              >
                画布
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={centerView === 'json'}
                data-testid="builder-view-json"
                onClick={() => setCenterView('json')}
              >
                JSON
              </button>
            </span>
            <span className="meta">{selectedPath || 'root'}</span>
          </div>
          {centerView === 'canvas' ? (
            <BehaviorTreeBuilder
              definition={definition}
              selectedPath={selectedPath}
              onSelect={onSelect}
              onInsertNode={onAddNode}
            />
          ) : (
            <pre data-testid="definition" className="definition-json" tabIndex={0}>
              {highlightJson(definitionText).map((span, index) => (
                <span className={`json-${span.kind}`} key={`${span.kind}-${index}`}>
                  {span.text}
                </span>
              ))}
            </pre>
          )}
        </section>

        <aside className="inspector" data-testid="node-inspector">
          <h3>Inspector</h3>
          <label>
            类型
            <select
              data-testid="node-type"
              value={typeSelectValue(selected)}
              onChange={(event) => onReplaceType(nodeInputFromTypeSelect(event.target.value, capabilities))}
            >
              {PALETTE_GROUPS.map((group) => (
                <optgroup key={group.title} label={group.title}>
                  {group.types.map((type) => (
                    <option key={type} value={type}>
                      {type}
                    </option>
                  ))}
                </optgroup>
              ))}
              <optgroup label="Capabilities">
                {LEAF_TYPES.has(selected.type) &&
                'capability' in selected &&
                !capabilities.some(
                  (capability) => capability.adapter === selected.adapter && capability.key === selected.capability,
                ) ? (
                  <option value={typeSelectValue(selected)}>
                    {selected.adapter}/{selected.capability}
                  </option>
                ) : null}
                {capabilities.map((capability) => (
                  <option
                    key={`${capability.adapter}::${capability.key}`}
                    value={`leaf:${capability.adapter}::${capability.key}`}
                  >
                    {capability.adapter}/{capability.label}
                  </option>
                ))}
              </optgroup>
            </select>
          </label>
          {LEAF_TYPES.has(selected.type) && (
            <LeafInspector capabilities={capabilities} leaf={selected as LeafNode} onUpdateLeaf={onUpdateLeaf} />
          )}
          {selected.type === 'RetryUntilSuccessful' && (
            <label>
              num_attempts（-1 无限）
              <input
                type="number"
                min="-1"
                step="1"
                value={selected.num_attempts}
                onChange={(event) => onUpdateNumber('num_attempts', event.target.value)}
              />
            </label>
          )}
          {selected.type === 'Repeat' && (
            <label>
              num_cycles（-1 无限）
              <input
                type="number"
                min="-1"
                step="1"
                value={selected.num_cycles}
                onChange={(event) => onUpdateNumber('num_cycles', event.target.value)}
              />
            </label>
          )}
          {(selected.type === 'Timeout' || selected.type === 'Delay') && (
            <label>
              msec
              <input
                type="number"
                min="1"
                step="100"
                value={selected.msec}
                onChange={(event) => onUpdateNumber('msec', event.target.value)}
              />
            </label>
          )}
          {selected.type === 'Parallel' && (
            <>
              <label>
                success_count（-1 全部）
                <input
                  type="number"
                  step="1"
                  value={selected.success_count ?? -1}
                  onChange={(event) => onUpdateNumber('success_count', event.target.value)}
                />
              </label>
              <label>
                failure_count
                <input
                  type="number"
                  step="1"
                  value={selected.failure_count ?? 1}
                  onChange={(event) => onUpdateNumber('failure_count', event.target.value)}
                />
              </label>
            </>
          )}
          {selected.type === 'ParallelAll' && (
            <label>
              max_failures
              <input
                type="number"
                step="1"
                value={selected.max_failures ?? 1}
                onChange={(event) => onUpdateNumber('max_failures', event.target.value)}
              />
            </label>
          )}
          {selected.type === 'Switch' && (
            <>
              <label>
                黑板变量
                <input value={selected.variable} onChange={(event) => onUpdateVariable?.(event.target.value)} />
              </label>
              {selected.cases.map((value, index) => (
                <label key={index}>
                  case {index + 1}
                  <input value={value} onChange={(event) => onUpdateSwitchCase?.(index, event.target.value)} />
                  <button type="button" onClick={() => onRemoveSwitchCase?.(index)}>
                    删除 case
                  </button>
                </label>
              ))}
              <button type="button" onClick={() => onAddNode('Sequence')}>
                添加 case
              </button>
            </>
          )}
          {selected.type === 'SubTree' && (
            <label>
              子树 id
              <input value={selected.id} onChange={(event) => onUpdateVariable?.(event.target.value)} />
            </label>
          )}
          <div className="toolbar">
            <button className="danger" type="button" disabled={!selectedPath} onClick={onDeleteNode}>
              <Trash2 size={16} />
              删除节点
            </button>
            <button type="button" disabled={!canMove(definition, selectedPath)} onClick={() => onMoveNode(-1)}>
              上移
            </button>
            <button type="button" disabled={!canMove(definition, selectedPath)} onClick={() => onMoveNode(1)}>
              下移
            </button>
          </div>
          <SessionsPanel
            adapters={adapters}
            selectedIndex={selectedSession}
            sessions={definition.sessions}
            onSelect={setSelectedSession}
            onUpdate={onUpdateSessions}
          />
        </aside>
      </div>
    </section>
  );
}

function SessionsPanel({
  adapters,
  selectedIndex,
  sessions,
  onSelect,
  onUpdate,
}: {
  adapters: readonly HttpAdapter[];
  selectedIndex: number;
  sessions: SessionBinding[];
  onSelect: (index: number) => void;
  onUpdate: (sessions: SessionBinding[]) => void;
}) {
  const grouped = new Map<string, Array<{ row: SessionBinding; index: number }>>();
  for (const [index, row] of sessions.entries()) {
    const list = grouped.get(row.adapter) ?? [];
    list.push({ row, index });
    grouped.set(row.adapter, list);
  }
  const currentIndex = sessions.length === 0 ? -1 : Math.min(selectedIndex, sessions.length - 1);
  const current = currentIndex >= 0 ? sessions[currentIndex] : undefined;
  const adapter = adapters.find((item) => item.id === current?.adapter);
  const ports = adapter?.session?.ports ?? [];

  function updatePorts(ports: SessionBinding['ports']) {
    if (currentIndex < 0) return;
    onUpdate(sessions.map((row, rowIndex) => (rowIndex === currentIndex ? { ...row, ports } : row)));
  }

  return (
    <div className="sessions-panel" data-testid="sessions-panel">
      <h3>Sessions</h3>
      <p className="meta">由叶子上的 adapter / actor 自动算出。Session 输入口可接字面量或本 Run 的黑板键。</p>
      {sessions.length === 0 ? <p className="meta">树上还没有填了 actor 的叶子。</p> : null}
      {[...grouped.entries()].map(([adapterId, rows]) => (
        <div className="session-group" key={adapterId}>
          <div className="palette-title">{adapterId}</div>
          {rows.map(({ row, index }) => (
            <button
              className={index === currentIndex ? 'session-row selected' : 'session-row'}
              data-testid={`session-row-${index}`}
              key={`${row.adapter}/${row.actor}/${index}`}
              type="button"
              onClick={() => onSelect(index)}
            >
              {row.actor || '(未填 actor)'}
            </button>
          ))}
        </div>
      ))}
      {current ? (
        <>
          <p className="meta" data-testid="session-identity">
            {current.adapter} / {current.actor || '(未填 actor)'}
          </p>
          {ports.length === 0 ? <p className="meta">该 Adapter 没有 Session 口。</p> : null}
          {ports.map((port) => (
            <SessionPortField
              key={port.name}
              binding={current.ports?.[port.name]}
              port={port}
              onChange={(binding) => {
                const next = { ...current.ports };
                if (!binding) delete next[port.name];
                else next[port.name] = binding;
                updatePorts(next);
              }}
            />
          ))}
        </>
      ) : null}
    </div>
  );
}

function SessionPortField({
  binding,
  port,
  onChange,
}: {
  binding: PortBinding | undefined;
  port: PortDefinition;
  onChange: (binding: PortBinding | undefined) => void;
}) {
  const mode = binding && 'key' in binding ? 'key' : 'literal';
  return (
    <fieldset className="port-field">
      <legend>
        {port.name} (in
        {port.required === false ? '' : ', required'})
      </legend>
      <label>
        接线
        <select
          data-testid={`session-port-mode-${port.name}`}
          value={mode}
          onChange={(event) =>
            onChange(
              event.target.value === 'key'
                ? { key: binding && 'key' in binding ? binding.key : '' }
                : { literal: binding && 'literal' in binding ? binding.literal : '' },
            )
          }
        >
          <option value="literal">字面量</option>
          <option value="key">黑板键</option>
        </select>
      </label>
      <label>
        {mode === 'key' ? '黑板键' : '字面量'}
        <input
          data-testid={`session-port-${port.name}`}
          value={binding ? ('key' in binding ? binding.key : literalText(binding.literal)) : ''}
          onChange={(event) =>
            onChange(mode === 'key' ? { key: event.target.value } : { literal: parseLiteral(event.target.value) })
          }
        />
      </label>
    </fieldset>
  );
}

function LeafInspector({
  capabilities,
  leaf,
  onUpdateLeaf,
}: {
  capabilities: readonly CatalogCapability[];
  leaf: LeafNode;
  onUpdateLeaf: (
    input: Partial<{ adapter: string; capability: string; actor: string; ports: Record<string, PortBinding> }>,
  ) => void;
}) {
  const selectedKey = `${leaf.adapter}::${leaf.capability}`;
  const current = capabilities.find((capability) => `${capability.adapter}::${capability.key}` === selectedKey);
  const ports = current?.ports ?? [];

  function updatePort(name: string, binding: PortBinding | undefined) {
    const next = { ...leaf.ports };
    if (!binding) delete next[name];
    else next[name] = binding;
    onUpdateLeaf({ ports: next });
  }

  return (
    <>
      <label>
        Capability
        <select
          data-testid="node-capability"
          value={selectedKey}
          onChange={(event) => {
            const [adapter, ...rest] = event.target.value.split('::');
            onUpdateLeaf({ adapter, capability: rest.join('::'), ports: {} });
          }}
        >
          {capabilities
            .filter((capability) => capability.kind === leaf.type)
            .map((capability) => (
              <option
                key={`${capability.adapter}::${capability.key}`}
                value={`${capability.adapter}::${capability.key}`}
              >
                {capability.adapter}/{capability.label}
              </option>
            ))}
        </select>
      </label>
      <label>
        Actor
        <input
          value={leaf.actor}
          placeholder="robot1"
          onChange={(event) => onUpdateLeaf({ actor: event.target.value })}
        />
      </label>
      {ports.map((port) => {
        const binding = leaf.ports?.[port.name];
        const mode = binding && 'key' in binding ? 'key' : 'literal';
        return (
          <fieldset className="port-field" key={port.name}>
            <legend>
              {port.name} ({port.direction}
              {port.required === false ? '' : ', required'})
            </legend>
            {port.direction !== 'out' && (
              <label>
                接线
                <select
                  value={mode}
                  onChange={(event) => {
                    if (event.target.value === 'key')
                      updatePort(port.name, { key: binding && 'key' in binding ? binding.key : '' });
                    else updatePort(port.name, { literal: binding && 'literal' in binding ? binding.literal : '' });
                  }}
                >
                  <option value="literal">字面量</option>
                  <option value="key">黑板键</option>
                </select>
              </label>
            )}
            {port.direction === 'out' || mode === 'key' ? (
              <label>
                黑板键
                <input
                  value={binding && 'key' in binding ? binding.key : ''}
                  onChange={(event) =>
                    updatePort(port.name, event.target.value.trim() ? { key: event.target.value } : undefined)
                  }
                />
              </label>
            ) : (
              <label>
                字面量
                <input
                  value={binding && 'literal' in binding ? literalText(binding.literal) : ''}
                  onChange={(event) => updatePort(port.name, { literal: parseLiteral(event.target.value) })}
                />
              </label>
            )}
          </fieldset>
        );
      })}
    </>
  );
}

function literalText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function parseLiteral(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed === '') return '';
  try {
    return JSON.parse(trimmed);
  } catch {
    return text;
  }
}
