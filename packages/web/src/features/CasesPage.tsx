import { Play, Plus, Trash2 } from 'lucide-react';

import type { TestCase } from '@tp/contract';

type Props = {
  cases: TestCase[];
  onCreate: () => void;
  onEdit: (item: TestCase) => void;
  onStartRun: (item: TestCase) => void;
  onRemove: (item: TestCase) => void;
};

export function CasesPage({ cases, onCreate, onEdit, onStartRun, onRemove }: Props) {
  return (
    <section className="cases-page" data-testid="cases-page">
      <div className="section-head">
        <div>
          <h2>Cases</h2>
          <div className="meta">选择一个 Case 编辑或创建 Run。</div>
        </div>
        <button type="button" onClick={onCreate}>
          <Plus size={16} />
          新建
        </button>
      </div>
      <div className="case-grid">
        {cases.length === 0 ? (
          <div className="empty">暂无 case</div>
        ) : (
          cases.map((item) => (
            <article className="item" key={item.id}>
              <div className="row">
                <div className="title">{item.name}</div>
                <div className="meta">{item.id}</div>
              </div>
              <div className="toolbar">
                <button type="button" onClick={() => onEdit(item)}>
                  编辑
                </button>
                <button type="button" onClick={() => onStartRun(item)}>
                  <Play size={16} />
                  创建 Run
                </button>
                <button className="danger" type="button" onClick={() => onRemove(item)}>
                  <Trash2 size={16} />
                  删除
                </button>
              </div>
            </article>
          ))
        )}
      </div>
    </section>
  );
}
