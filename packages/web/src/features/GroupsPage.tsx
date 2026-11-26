import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Layers, Pencil, Play, Plus, Save, Search, Trash2, X } from 'lucide-react';
import type { TestCase, TestGroup } from '@tp/contract';

type GroupDraft = { id: string; name: string; caseIds: string[] };
type Props = {
  groups: TestGroup[];
  cases: TestCase[];
  onSave: (id: string, body: { name: string; caseIds: string[] }) => Promise<TestGroup>;
  onRemove: (group: TestGroup) => Promise<void>;
  onStart: (id: string) => void;
};

export function GroupsPage({ groups, cases, onSave, onRemove, onStart }: Props) {
  const [selectedId, setSelectedId] = useState('');
  const [draft, setDraft] = useState<GroupDraft | null>(null);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState<'save' | 'delete' | null>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const createButton = useRef<HTMLButtonElement>(null);
  const editButton = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<HTMLButtonElement | null>(null);
  const editing = draft !== null;
  const creating = draft?.id === '';
  const busy = pending !== null;
  const selected = groups.find((group) => group.id === selectedId) ?? groups[0];
  const byId = new Map(cases.map((item) => [item.id, item]));
  const chosenIds = new Set(draft?.caseIds);
  const search = query.trim().toLowerCase();
  const visibleCases = cases.filter((item) => `${item.name} ${item.description}`.toLowerCase().includes(search));
  const missingIds = draft?.caseIds.filter((id) => !byId.has(id)) ?? [];

  useEffect(() => {
    if (busy) return;
    if (editing) nameInput.current?.focus();
    else if (returnFocus.current) {
      const target = returnFocus.current.isConnected
        ? returnFocus.current
        : (editButton.current ?? createButton.current);
      target?.focus();
      returnFocus.current = null;
    }
  }, [editing, busy]);

  function edit(group: TestGroup | undefined, trigger: HTMLButtonElement) {
    returnFocus.current = trigger;
    setDraft({ id: group?.id ?? '', name: group?.name ?? '', caseIds: group ? [...group.caseIds] : [] });
    setQuery('');
    setError('');
  }

  function toggleCase(id: string, checked: boolean) {
    setDraft(
      (current) =>
        current && {
          ...current,
          caseIds: checked ? [...current.caseIds, id] : current.caseIds.filter((item) => item !== id),
        },
    );
  }

  async function act(action: 'save' | 'delete', operation: () => Promise<void>) {
    setPending(action);
    setError('');
    try {
      await operation();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setPending(null);
    }
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!draft) return;
    await act('save', async () => {
      const saved = await onSave(draft.id, { name: draft.name, caseIds: draft.caseIds });
      setSelectedId(saved.id);
      setDraft(null);
      setQuery('');
    });
  }

  function select(id: string) {
    setSelectedId(id);
    setError('');
  }

  return (
    <section className="groups-page" data-testid="groups-page">
      <div className="section-head">
        <div className="groups-heading">
          <h2>Groups</h2>
          <span className="meta">{groups.length} 个分组</span>
        </div>
        <button
          ref={createButton}
          className={groups.length === 0 ? 'primary' : undefined}
          type="button"
          disabled={busy || editing}
          onClick={(event) => edit(undefined, event.currentTarget)}
        >
          <Plus size={16} aria-hidden="true" />
          新建组
        </button>
      </div>
      <div className="groups-mobile-picker">
        <label htmlFor="group-selection">当前分组</label>
        <select
          id="group-selection"
          value={creating ? '' : (selected?.id ?? '')}
          disabled={busy || editing || groups.length === 0}
          onChange={(event) => select(event.target.value)}
        >
          {creating ? <option value="">新建分组</option> : groups.length === 0 && <option value="">暂无分组</option>}
          {groups.map((group) => (
            <option key={group.id} value={group.id}>
              {group.name} · {group.caseIds.length} 条 Case
            </option>
          ))}
        </select>
      </div>
      <div className="groups-workspace">
        <aside className="groups-sidebar">
          <div className="group-list-label">测试分组</div>
          <nav className="group-list" aria-label="分组列表">
            {groups.map((group) => (
              <button
                type="button"
                key={group.id}
                aria-pressed={!creating && selected?.id === group.id}
                disabled={busy || editing}
                onClick={() => select(group.id)}
              >
                <span className="group-list-name">{group.name}</span>
                <span className="group-count" aria-label={`${group.caseIds.length} 条 Case`}>
                  {group.caseIds.length}
                </span>
              </button>
            ))}
          </nav>
          {editing && <p className="meta group-edit-hint">请先保存或取消当前编辑</p>}
        </aside>
        {draft ? (
          <form className="group-detail" onSubmit={save} aria-label={draft.id ? '编辑 Group' : '新建 Group'}>
            <div className="group-detail-head">
              <div>
                <h3>{draft.id ? '编辑分组' : '新建分组'}</h3>
                <p className="meta">已选 {draft.caseIds.length} 条 Case</p>
              </div>
              <div className="toolbar group-actions">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setDraft(null);
                    setQuery('');
                    setError('');
                  }}
                >
                  <X size={15} aria-hidden="true" />
                  取消
                </button>
                <button type="submit" className="primary" disabled={busy}>
                  <Save size={15} aria-hidden="true" />
                  {pending === 'save' ? '保存中…' : '保存组'}
                </button>
              </div>
            </div>
            {error && (
              <p className="group-error" role="alert">
                {error}
              </p>
            )}
            <div className="group-editor-fields">
              <label htmlFor="group-name">组名</label>
              <input
                ref={nameInput}
                id="group-name"
                name="name"
                required
                value={draft.name}
                readOnly={busy}
                onChange={(event) => {
                  const name = event.target.value;
                  setDraft((current) => current && { ...current, name });
                }}
              />
            </div>
            <div className="group-members-head">
              <span>选择 Case</span>
              <span className="meta">{visibleCases.length} 条结果</span>
            </div>
            <div className="group-search">
              <Search size={16} aria-hidden="true" />
              <input
                type="search"
                aria-label="搜索 Case"
                placeholder="搜索 Case 名称或描述"
                value={query}
                readOnly={busy}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') event.preventDefault();
                }}
              />
            </div>
            <fieldset className="group-case-picker" disabled={busy}>
              <legend className="group-sr-only">引用的 Case</legend>
              {visibleCases.map((item) => (
                <label className="group-case-pick" data-selected={chosenIds.has(item.id)} key={item.id}>
                  <input
                    type="checkbox"
                    aria-label={item.name}
                    checked={chosenIds.has(item.id)}
                    onChange={(event) => toggleCase(item.id, event.target.checked)}
                  />
                  <span className="group-case-copy">
                    <span className="group-case-name">{item.name}</span>
                    <span className="group-case-description">{item.description}</span>
                  </span>
                </label>
              ))}
              {missingIds.map((id) => (
                <label className="group-case-pick group-case-missing" key={id}>
                  <input type="checkbox" checked onChange={() => toggleCase(id, false)} />
                  <span className="group-case-copy">
                    <span className="group-case-name">不存在的 Case：{id}</span>
                    <span className="group-case-description">取消勾选以移除此引用</span>
                  </span>
                </label>
              ))}
              {visibleCases.length === 0 && (
                <p className="empty group-empty-results">
                  {cases.length === 0 ? '请先创建 Case。' : '没有匹配的 Case。'}
                </p>
              )}
            </fieldset>
          </form>
        ) : selected ? (
          <div className="group-detail" role="region" aria-labelledby="group-detail-heading">
            <div className="group-detail-head">
              <div className="group-detail-title">
                <h3 id="group-detail-heading">{selected.name}</h3>
                <p className="meta">{selected.caseIds.length} 条 Case</p>
              </div>
              <div className="toolbar group-actions">
                <button
                  ref={editButton}
                  type="button"
                  disabled={busy}
                  onClick={(event) => edit(selected, event.currentTarget)}
                >
                  <Pencil size={15} aria-hidden="true" />
                  编辑成员
                </button>
                <button
                  type="button"
                  className="danger"
                  disabled={busy}
                  onClick={(event) => {
                    returnFocus.current = event.currentTarget;
                    void act('delete', async () => {
                      await onRemove(selected);
                      setSelectedId(groups.find((group) => group.id !== selected.id)?.id ?? '');
                      returnFocus.current = editButton.current ?? createButton.current;
                    });
                  }}
                >
                  <Trash2 size={15} aria-hidden="true" />
                  {pending === 'delete' ? '删除中…' : '删除组'}
                </button>
                <button
                  type="button"
                  className="primary"
                  disabled={busy || selected.caseIds.length === 0}
                  onClick={() => onStart(selected.id)}
                >
                  <Play size={15} aria-hidden="true" />
                  运行组
                </button>
              </div>
            </div>
            {error && (
              <p className="group-error" role="alert">
                {error}
              </p>
            )}
            <div className="group-members-head">
              <span>分组成员</span>
            </div>
            {selected.caseIds.length === 0 ? (
              <p className="empty group-empty-results">这个分组还没有 Case，编辑成员后即可运行。</p>
            ) : (
              <ol className="group-case-list" aria-label="分组成员" tabIndex={0}>
                {selected.caseIds.map((id, index) => {
                  const item = byId.get(id);
                  return (
                    <li className="group-case-row" key={id}>
                      <span className="group-case-index" aria-hidden="true">
                        {String(index + 1).padStart(2, '0')}
                      </span>
                      <div className="group-case-copy">
                        <span className="group-case-name">{item?.name ?? `不存在的 Case：${id}`}</span>
                        {item && <span className="group-case-description">{item.description}</span>}
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
          </div>
        ) : (
          <div className="group-empty-state">
            <Layers size={32} aria-hidden="true" />
            <h3>暂无分组</h3>
            <p>新建一个分组，组织需要一起运行的 Case。</p>
          </div>
        )}
      </div>
    </section>
  );
}
