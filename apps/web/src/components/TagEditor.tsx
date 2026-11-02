import { useEffect, useRef, useState } from 'react';
import { api } from '../api';

/**
 * The label on a one-off expense in Miscellaneous. Shows the tag (marked "suggested" when Claude picked it);
 * click to change it. With no tag yet, it's a small box asking for one.
 */
export function TagEditor({ id, tag, source, prompt, onSaved }: { id: string; tag: string | null | undefined; source?: string | null; prompt?: boolean; onSaved: () => void }) {
  const [editing, setEditing] = useState(!tag);
  const [value, setValue] = useState(tag ?? '');
  const box = useRef<HTMLInputElement>(null);
  useEffect(() => { setValue(tag ?? ''); setEditing(!tag); }, [tag]);
  useEffect(() => { if (prompt) box.current?.focus(); }, [prompt]);

  const save = async () => {
    const v = value.trim();
    if (v === (tag ?? '')) { if (v) setEditing(false); return; }
    await api.patch(`/api/transactions/${id}`, { tag: v || null });
    onSaved();
  };

  if (!editing && tag) {
    return (
      <button type="button" className={'tag-chip' + (source === 'ai' ? ' ai' : '')} onClick={() => setEditing(true)}
        title={source === 'ai' ? 'Suggested by Claude. Click to change.' : 'Click to change the tag'}>
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round" aria-hidden="true"><path d="M3 12V4h8l10 10-8 8L3 12z" /><circle cx="7.5" cy="7.5" r="1.5" /></svg>
        {tag}{source === 'ai' && <span className="tag-ai">suggested</span>}
      </button>
    );
  }
  return (
    <input ref={box} className={'input sm tag-input' + (prompt ? ' prompt' : '')} value={value} maxLength={40} aria-label="Tag for this expense"
      placeholder={prompt ? 'What was this for?' : 'Add a tag…'} onChange={(e) => setValue(e.target.value)} onBlur={save}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') { setValue(tag ?? ''); if (tag) setEditing(false); } }} />
  );
}
