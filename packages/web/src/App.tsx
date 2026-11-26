import { RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';

import {
  cancelRun,
  createCase,
  createGroup,
  updateGroup,
  deleteGroup,
  listGroups,
  createBatch,
  cancelBatch,
  deleteCase,
  listAdapters,
  listCases,
  listBatches,
  getBatch,
  listRuns,
  listWorkers,
  runEventsPath,
  updateCase,
  type HttpAdapter,
} from './api/client.ts';
import { BatchCreateDialog } from './features/BatchCreateDialog.tsx';
import { BuilderPage } from './features/BuilderPage.tsx';
import { GroupsPage } from './features/GroupsPage.tsx';
import { CasesPage } from './features/CasesPage.tsx';
import { RunsPage } from './features/RunsPage.tsx';
import { WorkersPage } from './features/WorkersPage.tsx';
import type { CatalogCapability } from '@tp/contract';
import {
  httpRunSchema,
  requireCaseDefinition,
  type CaseDefinition,
  type Batch,
  type LeafNode,
  type PortBinding,
  type Run,
  type TestCase,
  type TestGroup,
  type WorkerSlot,
} from '@tp/contract';
import { appViewHash, parseAppLocation, type AppView } from './domain/app-view.ts';
import {
  defaultDefinition,
  deleteNode,
  dropNode,
  getNode,
  LEAF_TYPES,
  moveNode,
  replaceNodeType,
  syncCaseSessions,
  updateLeaf,
  updateWrapper,
  type DropMode,
  type NodeInput,
} from './domain/behavior-tree.ts';
import {
  advanceSelectedRunSnapshot,
  defaultExpandedRunId,
  mergeIncomingRuns,
  mergeRuns,
  preferNewerRun,
  visibleRunsWithSelectedSnapshot,
  type SelectedRunCache,
  type UnifiedRun,
} from './domain/run-progress.ts';

const VIEWS: { id: AppView; label: string }[] = [
  { id: 'runs', label: 'Runs' },
  { id: 'cases', label: 'Cases' },
  { id: 'groups', label: 'Groups' },
  { id: 'builder', label: 'Builder' },
  { id: 'workers', label: 'Workers' },
];

const BATCH_PAGE_SIZE = 20;

export function App() {
  const [view, setViewState] = useState<AppView>(() => parseAppLocation(window.location.hash).view);
  const [focusBatchId, setFocusBatchId] = useState<string | null>(() => parseAppLocation(window.location.hash).batchId);
  const [groups, setGroups] = useState<TestGroup[]>([]);
  const [cases, setCases] = useState<TestCase[]>([]);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [batchOffset, setBatchOffset] = useState(0);
  const [batchTotal, setBatchTotal] = useState(0);
  const [pageLoading, setPageLoading] = useState(false);
  const batchOffsetRef = useRef(0);
  const focusBatchIdRef = useRef(focusBatchId);
  const [runs, setRuns] = useState<Run[]>([]);
  const [workerRuns, setWorkerRuns] = useState<Run[]>([]);
  const [workers, setWorkers] = useState<WorkerSlot[]>([]);
  const [adapters, setAdapters] = useState<HttpAdapter[]>([]);
  const [capabilities, setCapabilities] = useState<CatalogCapability[]>([]);
  const [draft, setDraft] = useState<CaseDefinition>(defaultDefinition);
  const [selectedPath, setSelectedPath] = useState('');
  const [caseId, setCaseId] = useState('');
  const [caseName, setCaseName] = useState('Browser smoke');
  const [caseDescription, setCaseDescription] = useState('');
  const [batchSelection, setBatchSelection] = useState<{
    selector: { caseIds: string[] } | { groupId: string };
    label: string;
  } | null>(null);
  const [status, setStatus] = useState('');
  const [connectionWarning, setConnectionWarning] = useState('');
  const [catalogWarning, setCatalogWarning] = useState('');
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
  const [selectedRunCache, setSelectedRunCache] = useState<SelectedRunCache | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const refreshInFlight = useRef<Promise<void> | null>(null);
  const catalogRefreshInFlight = useRef<Promise<void> | null>(null);
  const catalogsLoaded = useRef(false);
  const expandedRunIdRef = useRef<string | null>(null);
  const selectedRunCacheRef = useRef<SelectedRunCache | null>(null);
  const runsRef = useRef<Run[]>([]);

  const selected = useMemo(() => getNode(draft, selectedPath), [draft, selectedPath]);
  const definitionText = useMemo(() => JSON.stringify(draft, null, 2), [draft]);
  const unifiedRuns = useMemo(() => mergeRuns(runs), [runs]);
  const visibleRuns = useMemo(
    () => visibleRunsWithSelectedSnapshot(unifiedRuns, expandedRunId ?? '', selectedRunCache),
    [expandedRunId, selectedRunCache, unifiedRuns],
  );

  const setView = useCallback((next: AppView) => {
    setViewState(next);
    setFocusBatchId(null);
    focusBatchIdRef.current = null;
    const hash = appViewHash(next);
    if (window.location.hash !== hash) window.location.hash = hash;
  }, []);

  const applyRunSelection = useCallback((id: string | null, cache: SelectedRunCache | null) => {
    expandedRunIdRef.current = id;
    selectedRunCacheRef.current = cache;
    setExpandedRunId(id);
    setSelectedRunCache(cache);
  }, []);

  const applyWatchedRun = useCallback(
    (incoming: Run) => {
      const selected = selectedRunCacheRef.current?.snapshot.run;
      const run = preferNewerRun(selected?.id === incoming.id ? selected : undefined, incoming);
      setRuns((current) => {
        const next = current.some((item) => item.id === run.id)
          ? current.map((item) => (item.id === run.id ? preferNewerRun(item, run) : item))
          : [...current, run];
        runsRef.current = next;
        return next;
      });
      if (expandedRunIdRef.current !== run.id) return;
      applyRunSelection(run.id, {
        snapshot: {
          kind:
            run.status === 'queued' || run.status === 'running' || run.status === 'canceling' ? 'active' : 'finished',
          run,
        },
        missingSuccessfulPolls: 0,
      });
    },
    [applyRunSelection],
  );

  const refreshCatalogs = useCallback((includeAdapters = !catalogsLoaded.current): Promise<void> => {
    if (catalogRefreshInFlight.current) {
      return catalogRefreshInFlight.current.then(() => refreshCatalogs(includeAdapters));
    }
    const request = (async () => {
      try {
        const [nextCases, nextGroups, nextAdapters] = await Promise.all([
          listCases(),
          listGroups(),
          includeAdapters ? listAdapters() : null,
        ]);
        const parsedCases = nextCases.items.map((item) => ({
          ...item,
          definition: requireCaseDefinition(item.definition),
        }));
        setCases(parsedCases);
        setGroups(nextGroups.items);
        if (nextAdapters) {
          setAdapters(nextAdapters.items);
          setCapabilities(nextAdapters.items.flatMap((adapter) => adapter.capabilities));
        }
        catalogsLoaded.current = true;
        setCatalogWarning('');
      } catch (error) {
        setCatalogWarning(`目录加载失败，继续显示上次数据：${errorMessage(error)}`);
      } finally {
        catalogRefreshInFlight.current = null;
      }
    })();
    catalogRefreshInFlight.current = request;
    return request;
  }, []);

  const refresh = useCallback(
    (query?: { offset: number; focusBatchId: string | null }): Promise<void> => {
      if (refreshInFlight.current) {
        return query ? refreshInFlight.current.then(() => refresh(query)) : refreshInFlight.current;
      }
      let offset = query?.offset ?? batchOffsetRef.current;
      const focusId = query ? query.focusBatchId : focusBatchIdRef.current;
      const request = (async () => {
        try {
          const [nextBatchPage, nextWorkers] = await Promise.all([
            listBatches({ limit: BATCH_PAGE_SIZE, offset }),
            listWorkers(),
          ]);
          if (offset > 0 && nextBatchPage.items.length === 0) {
            offset = Math.max(0, Math.ceil(nextBatchPage.total / BATCH_PAGE_SIZE) - 1) * BATCH_PAGE_SIZE;
            Object.assign(nextBatchPage, await listBatches({ limit: BATCH_PAGE_SIZE, offset }));
          }
          let focusWarning = '';
          if (focusId && !nextBatchPage.items.some((batch) => batch.id === focusId)) {
            try {
              nextBatchPage.items.push(await getBatch(focusId));
            } catch (error) {
              focusWarning = `批次 ${focusId} 加载失败：${errorMessage(error)}`;
            }
          }
          const pageRuns = nextBatchPage.items.flatMap((batch) => batch.runs);
          const offPageWorkers = nextWorkers.items.some(
            (worker) => worker.runId && !pageRuns.some((run) => run.id === worker.runId),
          );
          const activeRuns = offPageWorkers
            ? (await listRuns({ status: ['running', 'canceling'], limit: nextWorkers.items.length, offset: 0 })).items
            : [];
          if (focusId !== focusBatchIdRef.current) return;
          const pageChanged = offset !== batchOffsetRef.current;
          const mergedItems = mergeIncomingRuns(runsRef.current, pageRuns);
          const nextRuns = mergeRuns(mergedItems);
          if (pageChanged && !nextRuns.some((item) => item.run.id === expandedRunIdRef.current)) {
            applyRunSelection(null, null);
          }
          const currentId = expandedRunIdRef.current;
          if (currentId === null) {
            const nextId = defaultExpandedRunId(currentId, nextRuns);
            applyRunSelection(
              nextId,
              nextId === null ? null : advanceSelectedRunSnapshot(nextRuns, nextId, null).cache,
            );
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
          runsRef.current = mergedItems;
          setRuns(mergedItems);
          setBatches((current) => {
            const cached = selectedRunCacheRef.current?.snapshot.run;
            const previous = cached && current.find((batch) => batch.id === cached.batchId);
            return !pageChanged && previous && !nextBatchPage.items.some((batch) => batch.id === previous.id)
              ? [...nextBatchPage.items, previous]
              : nextBatchPage.items;
          });
          batchOffsetRef.current = offset;
          setBatchOffset(offset);
          setBatchTotal(nextBatchPage.total);
          setWorkerRuns([...pageRuns, ...activeRuns]);
          setWorkers(nextWorkers.items);
          setConnectionWarning(focusWarning);
        } catch (error) {
          setConnectionWarning(`连接异常，继续显示上次数据：${errorMessage(error)}`);
        } finally {
          refreshInFlight.current = null;
        }
      })();
      refreshInFlight.current = request;
      return request;
    },
    [applyRunSelection],
  );

  useEffect(() => {
    if (!catalogsLoaded.current || view === 'cases' || view === 'groups' || view === 'builder') {
      void refreshCatalogs(!catalogsLoaded.current);
    }
  }, [refreshCatalogs, view]);

  useEffect(() => {
    function onHashChange() {
      const location = parseAppLocation(window.location.hash);
      setViewState(location.view);
      setFocusBatchId(location.batchId);
      if (focusBatchIdRef.current !== location.batchId) {
        focusBatchIdRef.current = location.batchId;
        void refresh({ offset: 0, focusBatchId: location.batchId });
      }
    }
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, [refresh]);

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

  useEffect(() => {
    if (!expandedRunId) return;
    const source = new EventSource(runEventsPath(expandedRunId));
    const terminal = new Set(['passed', 'failed', 'canceled']);
    function onRun(event: MessageEvent<string>) {
      try {
        const run = httpRunSchema.parse(JSON.parse(event.data));
        applyWatchedRun(run);
        if (terminal.has(run.status)) source.close();
      } catch (error) {
        setConnectionWarning(`连接异常，继续显示上次数据：${errorMessage(error)}`);
      }
    }
    source.addEventListener('run', onRun);
    return () => {
      source.removeEventListener('run', onRun);
      source.close();
    };
  }, [applyWatchedRun, expandedRunId]);

  async function saveCase(event?: FormEvent) {
    event?.preventDefault();
    try {
      const body = { name: caseName, description: caseDescription, definition: draft };
      const saved = caseId ? await updateCase(caseId, body) : await createCase(body);
      setCaseId(saved.id);
      setStatus('已保存');
      await refreshCatalogs();
    } catch (error) {
      setStatus(errorMessage(error));
    }
  }

  async function enqueueRuns(
    body: ({ caseIds: string[] } | { groupId: string }) & { name?: string; description: string },
  ) {
    const batch = await createBatch({ ...body, trigger: { kind: 'web' } });
    setBatches((current) => [batch, ...current.filter((item) => item.id !== batch.id)]);
    const run = batch.runs[0];
    if (!run) return;
    applyRunSelection(run.id, {
      snapshot: { kind: 'active', run },
      missingSuccessfulPolls: 0,
    });
    setStatus('批次已进入执行队列');
    await refresh({ offset: 0, focusBatchId: focusBatchIdRef.current });
  }

  function startSelectedRun() {
    if (!caseId) {
      setStatus('请先保存 Case');
      return;
    }
    startBatch([caseId]);
  }

  function resetCase() {
    setCaseId('');
    setCaseName('');
    setCaseDescription('');
    setDraft(defaultDefinition());
    setSelectedPath('');
    setStatus('');
    setView('builder');
  }

  function editCase(item: TestCase) {
    setCaseId(item.id);
    setCaseName(item.name);
    setCaseDescription(item.description);
    setDraft(requireCaseDefinition(item.definition));
    setSelectedPath('');
    setStatus('');
    setView('builder');
  }

  function startBatch(caseIds: string[]) {
    setBatchSelection({
      selector: { caseIds },
      label: `Cases：${caseIds.map((id) => cases.find((item) => item.id === id)?.name ?? id).join('、')}`,
    });
  }

  function startGroup(groupId: string) {
    setBatchSelection({
      selector: { groupId },
      label: `Group：${groups.find((group) => group.id === groupId)?.name ?? groupId}`,
    });
  }

  async function removeCase(item: TestCase) {
    try {
      await deleteCase(item.id);
      if (caseId === item.id) {
        setCaseId('');
        setCaseName('');
        setDraft(defaultDefinition());
        setSelectedPath('');
        setStatus('');
      }
      await refreshCatalogs();
    } catch (error) {
      setStatus(errorMessage(error));
    }
  }

  const applyEdit = useCallback((result: { definition: CaseDefinition; selectedPath: string }) => {
    setDraft(syncCaseSessions(result.definition));
    setSelectedPath(result.selectedPath);
  }, []);

  function applySessions(sessions: CaseDefinition['sessions']) {
    setDraft({ ...draft, sessions });
  }

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
          {catalogWarning && (
            <span className="connection-warning" role="status">
              {catalogWarning}
            </span>
          )}
          <button type="button" onClick={() => Promise.all([refreshCatalogs(true), refresh()])}>
            <RefreshCw size={16} />
            刷新
          </button>
        </div>
      </header>

      <main className={`app-main view-${view}`}>
        {view === 'runs' && (
          <RunsPage
            batches={batches}
            total={batchTotal}
            offset={batchOffset}
            pageSize={BATCH_PAGE_SIZE}
            pageLoading={pageLoading}
            onPageChange={async (offset) => {
              setPageLoading(true);
              setView('runs');
              try {
                await refresh({ offset, focusBatchId: null });
              } finally {
                setPageLoading(false);
              }
            }}
            runs={visibleRuns}
            cases={cases}
            capabilities={capabilities}
            expandedRunId={expandedRunId}
            focusBatchId={focusBatchId}
            now={now}
            onCancelBatch={async (id) => {
              try {
                await cancelBatch(id);
                setStatus('已请求取消批次');
                await refresh();
              } catch (error) {
                setStatus(errorMessage(error));
              }
            }}
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
          <CasesPage
            cases={cases}
            onCreate={resetCase}
            onEdit={editCase}
            onStartBatch={startBatch}
            onRemove={removeCase}
          />
        )}
        {view === 'groups' && (
          <GroupsPage
            groups={groups}
            cases={cases}
            onStart={startGroup}
            onSave={async (id, body) => {
              const saved = id ? await updateGroup(id, body) : await createGroup(body);
              await refreshCatalogs();
              setGroups((current) =>
                current.some((group) => group.id === saved.id)
                  ? current.map((group) => (group.id === saved.id ? saved : group))
                  : [...current, saved],
              );
              return saved;
            }}
            onRemove={async (group) => {
              await deleteGroup(group.id);
              await refreshCatalogs();
              setGroups((current) => current.filter((item) => item.id !== group.id));
            }}
          />
        )}
        {view === 'workers' && (
          <WorkersPage
            workers={workers}
            runs={workerRuns}
            cases={cases}
            onOpenRun={async (runId) => {
              try {
                const run =
                  workerRuns.find((run) => run.id === runId) ??
                  (await listRuns({ status: ['running', 'canceling'], limit: workers.length, offset: 0 })).items.find(
                    (run) => run.id === runId,
                  );
                if (!run) throw new Error(`Run ${runId} 已结束，请刷新 Workers`);
                applyRunSelection(runId, {
                  snapshot: { kind: 'active', run },
                  missingSuccessfulPolls: 0,
                });
                window.location.hash = `#/runs/${encodeURIComponent(run.batchId)}`;
              } catch (error) {
                setStatus(errorMessage(error));
              }
            }}
          />
        )}
        {view === 'builder' && (
          <BuilderPage
            caseName={caseName}
            caseDescription={caseDescription}
            onCaseDescriptionChange={setCaseDescription}
            adapters={adapters}
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
            onUpdateSessions={applySessions}
          />
        )}
      </main>
      {batchSelection && (
        <BatchCreateDialog
          selectionLabel={batchSelection.label}
          onCreate={(metadata) => enqueueRuns({ ...batchSelection.selector, ...metadata })}
          onClose={() => setBatchSelection(null)}
        />
      )}
    </>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
