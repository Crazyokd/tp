import { useEffect, useRef, useState, type FormEvent } from 'react';

type Props = {
  selectionLabel: string;
  onCreate: (metadata: { name?: string; description: string }) => Promise<void>;
  onClose: () => void;
};

export function BatchCreateDialog({ selectionLabel, onCreate, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const submitting = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  useEffect(() => {
    const element = dialog.current!;
    const trigger = document.activeElement;
    element.showModal();
    return () => {
      element.close();
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
    };
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submitting.current) return;
    submitting.current = true;
    setPending(true);
    setError('');
    try {
      await onCreate({ ...(name.trim() ? { name: name.trim() } : {}), description });
      onClose();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }

  return (
    <dialog
      ref={dialog}
      className="batch-create-dialog"
      aria-labelledby="batch-create-title"
      aria-describedby="batch-create-selection"
      onCancel={(event) => {
        event.preventDefault();
        if (!submitting.current) onClose();
      }}
    >
      <form onSubmit={submit} aria-busy={pending}>
        <h2 id="batch-create-title">创建批次</h2>
        <p id="batch-create-selection">{selectionLabel}</p>
        <p className="meta">声明来源：web</p>
        <label htmlFor="batch-create-name">批次名称</label>
        <input
          id="batch-create-name"
          autoFocus
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="留空自动命名"
          disabled={pending}
        />
        <label htmlFor="batch-create-description">批次说明</label>
        <textarea
          id="batch-create-description"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          rows={3}
          disabled={pending}
        />
        {error && <p role="alert">{error}</p>}
        <div className="toolbar">
          <button type="button" disabled={pending} onClick={onClose}>
            取消
          </button>
          <button className="primary" type="submit" disabled={pending}>
            {pending ? '创建中…' : '创建批次'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
