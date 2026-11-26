import { useState } from 'react';
import { Play, Plus, Trash2 } from 'lucide-react';

import type { TestCase } from '@tp/contract';

type Props = {
  cases: TestCase[];
  onCreate: () => void;
  onEdit: (item: TestCase) => void;
  onStartBatch: (caseIds: string[]) => void;
  onRemove: (item: TestCase) => void;
};

export function CasesPage({ cases, onCreate, onEdit, onStartBatch, onRemove }: Props) {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const selected = cases.filter((item) => selectedIds.includes(item.id)).map((item) => item.id);
  return (
    <section className="cases-page" data-testid="cases-page">
      <div className="section-head">
        <div>
          <h2>Cases</h2>
          <div className="meta">选择 Case 编辑，或选择多条创建批次。</div>
        </div>
        <div className="toolbar">
          <button type="button" disabled={selected.length === 0} onClick={() => onStartBatch(selected)}>
            创建批次（{selected.length}）
          </button>
          <button type="button" onClick={onCreate}>
            <Plus size={16} />
            新建
          </button>
        </div>
      </div>
      {cases.length === 0 ? (
        <div className="empty">暂无 case</div>
      ) : (
        <div className="case-grid">
          {cases.map((item) => (
            <article className="item" key={item.id}>
              <div className="row">
                <label className="title case-selection">
                  <input
                    type="checkbox"
                    aria-label={`选择 ${item.name}`}
                    checked={selected.includes(item.id)}
                    onChange={(event) =>
                      setSelectedIds((current) =>
                        event.target.checked ? [...current, item.id] : current.filter((id) => id !== item.id),
                      )
                    }
                  />
                  {item.name}
                </label>
                <div className="meta">{item.id}</div>
              </div>
              <p className="case-description">{item.description}</p>
              <div className="toolbar">
                <button type="button" onClick={() => onEdit(item)}>
                  编辑
                </button>
                <button type="button" onClick={() => onStartBatch([item.id])}>
                  <Play size={16} />
                  创建批次
                </button>
                <button className="danger" type="button" onClick={() => onRemove(item)}>
                  <Trash2 size={16} />
                  删除
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
