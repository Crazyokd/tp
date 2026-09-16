import { RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';

import {
  cancelRun,
  createCase,
  createRun,
  deleteCase,
  listAdapters,
  listCases,
  listRuns,
  listWorkers,
  updateCase,
} from './api/client.ts';
import { BuilderPage } from './features/BuilderPage.tsx';
import { CasesPage } from './features/CasesPage.tsx';
import { RunsPage } from './features/RunsPage.tsx';
import { WorkersPage } from './features/WorkersPage.tsx';
import type { CatalogCapability } from '@tp/contract';
import {
  requireCaseDefinition,
  type CaseDefinition,
  type LeafNode,
  type PortBinding,
  type Run,
  type TestCase,
  type WorkerSlot,
} from '@tp/contract';
import { appViewHash, parseAppView, type AppView } from './domain/app-view.ts';
import {
  defaultDefinition,
  deleteNode,
  dropNode,
  getNode,
  LEAF_TYPES,
  moveNode,
  replaceNodeType,
  updateLeaf,
  updateWrapper,
  type DropMode,
  type NodeInput,
} from './domain/behavior-tree.ts';
import {
  advanceSelectedRunSnapshot,
  defaultExpandedRunId,
  mergeRuns,
  visibleRunsWithSelectedSnapshot,
  type SelectedRunCache,
  type UnifiedRun,
} from './domain/run-progress.ts';

const VIEWS: { id: AppView; label: string }[] = [
  { id: 'runs', label: 'Runs' },
  { id: 'cases', label: 'Cases' },
  { id: 'builder', label: 'Builder' },
  { id: 'workers', label: 'Workers' },
];

export function App() {
  const [view, setViewState] = useState<AppView>(() => parseAppView(window.location.hash));
  const [cases, setCases] = useState<TestCase[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [workers, setWorkers] = useState<WorkerSlot[]>([]);
  const [capabilities, setCapabilities] = useState<CatalogCapability[]>([]);
  const [draft, setDraft] = useState<CaseDefinition>(defaultDefinition);
  const [selectedPath, setSelectedPath] = useState('');
  const [caseId, setCaseId] = useState('');
  const [caseName, setCaseName] = useState('Browser smoke');
  const [status, setStatus] = useState('');
  const [connectionWarning, setConnectionWarning] = useState('');
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
  const [selectedRunCache, setSelectedRunCache] = useState<SelectedRunCache | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const refreshInFlight = useRef<Promise<void> | null>(null);
  const expandedRunIdRef = useRef<string | null>(null);
  const selectedRunCacheRef = useRef<SelectedRunCache | null>(null);

  const selected = useMemo(() => getNode(draft, selectedPath), [draft, selectedPath]);
  const definitionText = useMemo(() => JSON.stringify(draft, null, 2), [draft]);
  const unifiedRuns = useMemo(() => mergeRuns(runs), [runs]);
  const visibleRuns = useMemo(
    () => visibleRunsWithSelectedSnapshot(unifiedRuns, expandedRunId ?? '', selectedRunCache),
    [expandedRunId, selectedRunCache, unifiedRuns],
  );

  const setView = useCallback((next: AppView) => {
    setViewState(next);
    const hash = appViewHash(next);
    if (window.location.hash !== hash) window.location.hash = hash;
  }, []);

  const applyRunSelection = useCallback((id: string | null, cache: SelectedRunCache | null) => {
    expandedRunIdRef.current = id;
    selectedRunCacheRef.current = cache;
    setExpandedRunId(id);
    setSelectedRunCache(cache);
  }, []);

  const refresh = useCallback((): Promise<void> => {
    if (refreshInFlight.current) return refreshInFlight.current;
    const request = (async () => {
      try {
        const [nextCases, nextRunPage, nextAdapters, nextWorkers] = await Promise.all([
          listCases(),
          listRuns(),
          listAdapters(),
          listWorkers(),
        ]);
        const nextCapabilities = nextAdapters.items.flatMap((adapter) => adapter.capabilities);
        const nextRuns = mergeRuns(nextRunPage.items);
        const currentId = expandedRunIdRef.current;
        if (currentId === null) {
          const nextId = defaultExpandedRunId(currentId, nextRuns);
          applyRunSelection(nextId, nextId === null ? null : advanceSelectedRunSnapshot(nextRuns, nextId, null).cache);
        } else {
          const selection = advanceSelectedRunSnapshot(nextRuns, currentId, selectedRunCacheRef.current);
          if (selection.expired) {
            const nextId = defaultExpandedRunId(null, nextRuns);
            applyRunSelection(
              nextId,
              nextId === null ? null : advanceSelectedRunSnapshot(nextRuns, nextId, null).cache,
            );
          } else {
            applyRunSelection(currentId, selection.cache);
          }
        }
        setCases(nextCases.items.map((item) => ({ ...item, definition: requireCaseDefinition(item.definition) })));
        setRuns(nextRunPage.items);
        setWorkers(nextWorkers.items);
        setCapabilities(nextCapabilities);
        setConnectionWarning('');
      } catch (error) {
        setConnectionWarning(`连接异常，继续显示上次数据：${errorMessage(error)}`);
      } finally {
        refreshInFlight.current = null;
      }
    })();
    refreshInFlight.current = request;
    return request;
  }, [applyRunSelection]);

  useEffect(() => {
    function onHashChange() {
      setViewState(parseAppView(window.location.hash));
    }
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  useEffect(() => {
    let canceled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      await refresh();
      if (!canceled) timer = setTimeout(poll, 2000);
    }
    void poll();
    return () => {
      canceled = true;
      if (timer) clearTimeout(timer);
    };
  }, [refresh]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  async function saveCase(event?: FormEvent) {
    event?.preventDefault();
    try {
      const saved = caseId
        ? await updateCase(caseId, { name: caseName, definition: draft })
        : await createCase({ name: caseName, definition: draft });
      setCaseId(saved.id);
      setStatus('已保存');
      await refresh();
    } catch (error) {
      setStatus(errorMessage(error));
    }
  }

  async function startSelectedRun() {
    if (!caseId) {
      setStatus('请先保存 Case');
      return;
    }
    try {
      const run = await createRun({ caseId });
      applyRunSelection(run.id, {
        snapshot: { kind: 'active', run },
        missingSuccessfulPolls: 0,
      });
      setStatus('run 已进入执行队列');
      await refresh();
    } catch (error) {
      setStatus(errorMessage(error));
    }
  }

  function resetCase() {
    setCaseId('');
    setCaseName('');
    setDraft(defaultDefinition());
    setSelectedPath('');
    setStatus('');
    setView('builder');
  }

  function editCase(item: TestCase) {
    setCaseId(item.id);
    setCaseName(item.name);
    setDraft(requireCaseDefinition(item.definition));
    setSelectedPath('');
    setStatus('');
    setView('builder');
  }

  async function startRun(item: TestCase) {
    try {
      const run = await createRun({ caseId: item.id });
      applyRunSelection(run.id, {
        snapshot: { kind: 'active', run },
        missingSuccessfulPolls: 0,
      });
      setStatus('run 已进入执行队列');
      await refresh();
    } catch (error) {
      setStatus(errorMessage(error));
    }
  }

  async function removeCase(item: TestCase) {
    await deleteCase(item.id);
    if (caseId === item.id) {
      setCaseId('');
      setCaseName('');
      setDraft(defaultDefinition());
      setSelectedPath('');
      setStatus('');
    }
    await refresh();
  }

  const applyEdit = useCallback((result: { definition: CaseDefinition; selectedPath: string }) => {
    setDraft(result.definition);
    setSelectedPath(result.selectedPath);
  }, []);

  const addNode = useCallback(
    (input: NodeInput, path = selectedPath, mode?: DropMode) => {
      applyEdit(dropNode(draft, input, path, mode));
    },
    [applyEdit, draft, selectedPath],
  );

  function updateLeafField(
    input: Partial<{ adapter: string; capability: string; actor: string; ports: Record<string, PortBinding> }>,
  ) {
    if (!LEAF_TYPES.has(selected.type)) return;
    const leaf = selected as LeafNode;
    applyEdit(
      updateLeaf(draft, selectedPath, {
        adapter: input.adapter ?? leaf.adapter,
        capability: input.capability ?? leaf.capability,
        actor: input.actor ?? leaf.actor,
        ports: input.ports ?? leaf.ports ?? {},
      }),
    );
  }

  function updateNumber(
    field: 'num_attempts' | 'num_cycles' | 'msec' | 'success_count' | 'failure_count' | 'max_failures',
    value: string,
  ) {
    applyEdit(updateWrapper(draft, selectedPath, { [field]: Number(value) }));
  }

  function updateSwitchCase(index: number, value: string) {
    if (selected.type !== 'Switch') return;
    applyEdit(
      updateWrapper(draft, selectedPath, {
        cases: selected.cases.map((item, itemIndex) => (itemIndex === index ? value : item)),
      }),
    );
  }

  function removeSwitchCase(index: number) {
    applyEdit(deleteNode(draft, selectedPath ? `${selectedPath}.children.${index}` : `children.${index}`));
  }

  function updateVariable(value: string) {
    applyEdit(updateWrapper(draft, selectedPath, selected.type === 'SubTree' ? { id: value } : { variable: value }));
  }

  async function cancelActiveRun(id: string) {
    try {
      await cancelRun(id);
      setStatus('已请求取消 Run');
      await refresh();
    } catch (error) {
      setStatus(errorMessage(error));
    }
  }

  return (
    <>
      <header>
        <h1>TP Test Platform</h1>
        <nav className="app-nav" data-testid="app-nav" aria-label="模块">
          {VIEWS.map((item) => (
            <button
              aria-current={view === item.id ? 'page' : undefined}
              data-view={item.id}
              key={item.id}
              type="button"
              onClick={() => setView(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <div className="toolbar">
          {connectionWarning && (
            <span className="connection-warning" role="status">
              {connectionWarning}
            </span>
          )}
          {status && view !== 'builder' && (
            <span className="status" role="status">
              {status}
            </span>
          )}
          <a className="button" href="/swagger">
            API
          </a>
          <button type="button" onClick={refresh}>
            <RefreshCw size={16} />
            刷新
          </button>
        </div>
      </header>

      <main className={`app-main view-${view}`}>
        {view === 'runs' && (
          <RunsPage
            runs={visibleRuns}
            cases={cases}
            capabilities={capabilities}
            expandedRunId={expandedRunId}
            now={now}
            onCancel={cancelActiveRun}
            onToggle={(item: UnifiedRun) => {
              if (expandedRunId === item.run.id) {
                applyRunSelection('', null);
              } else {
                applyRunSelection(item.run.id, {
                  snapshot: item,
                  missingSuccessfulPolls: 0,
                });
              }
            }}
          />
        )}
        {view === 'cases' && (
          <CasesPage cases={cases} onCreate={resetCase} onEdit={editCase} onStartRun={startRun} onRemove={removeCase} />
        )}
        {view === 'workers' && (
          <WorkersPage
            workers={workers}
            runs={runs}
            cases={cases}
            onOpenRun={(runId) => {
              const item = unifiedRuns.find((entry) => entry.run.id === runId);
              applyRunSelection(runId, item ? { snapshot: item, missingSuccessfulPolls: 0 } : null);
              setView('runs');
            }}
          />
        )}
        {view === 'builder' && (
          <BuilderPage
            caseName={caseName}
            capabilities={capabilities}
            definition={draft}
            definitionText={definitionText}
            selected={selected}
            selectedPath={selectedPath}
            status={status}
            onAddNode={addNode}
            onCaseNameChange={setCaseName}
            onCreate={resetCase}
            onDeleteNode={() => applyEdit(deleteNode(draft, selectedPath))}
            onMoveNode={(delta) => applyEdit(moveNode(draft, selectedPath, delta))}
            onReplaceType={(input: NodeInput) => applyEdit(replaceNodeType(draft, selectedPath, input))}
            onSave={saveCase}
            onSelect={setSelectedPath}
            onStartRun={startSelectedRun}
            onUpdateLeaf={updateLeafField}
            onUpdateNumber={updateNumber}
            onUpdateVariable={updateVariable}
            onUpdateSwitchCase={updateSwitchCase}
            onRemoveSwitchCase={removeSwitchCase}
          />
        )}
      </main>
    </>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
