import { useEffect, useId, useMemo, useRef, useState } from 'react';

export interface PickOption { id: string; label: string; hint?: string }

/** Every word typed must appear somewhere in the label ("rest take" finds "Other › Restaurants & takeout"). */
const matches = (label: string, q: string) => q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => label.toLowerCase().includes(w));

/**
 * A dropdown you can type into. Click to browse the whole list, or start typing to narrow it; arrow keys move,
 * Enter picks, Esc closes. Works with touch keyboards too.
 */
export function CategoryPicker({ value, options, special = [], placeholder, onChange, label, compact, style }: {
  value: string | null;
  options: PickOption[];
  /** Choices that aren't categories (transfer, income, "choose later"), shown first. */
  special?: PickOption[];
  placeholder: string;
  onChange: (id: string) => void;
  label: string;
  compact?: boolean;
  style?: React.CSSProperties;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [hi, setHi] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const listId = useId();

  const all = useMemo(() => [...special, ...options], [special, options]);
  const current = all.find((o) => o.id === value);
  const shown = useMemo(() => (q.trim() ? all.filter((o) => matches(o.label, q)) : all), [all, q]);

  // With nothing typed, start on the current choice so it's in view.
  useEffect(() => { setHi(q.trim() ? 0 : Math.max(0, all.findIndex((o) => o.id === value))); }, [q, open]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open) return;
    list.current?.querySelector<HTMLElement>(`[data-i="${hi}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [hi, open]);

  const pick = (o: PickOption | undefined) => {
    if (!o) return;
    setOpen(false);
    setQ('');
    input.current?.blur();
    if (o.id !== value) onChange(o.id);
  };

  const key = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); if (!open) setOpen(true); else setHi((h) => Math.min(h + 1, shown.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); if (open) pick(shown[hi]); else setOpen(true); }
    else if (e.key === 'Escape') { setOpen(false); setQ(''); }
  };

  return (
    <div className={'picker' + (compact ? ' sm' : '')} style={style}>
      <input
        ref={input}
        className={'input' + (compact ? ' sm' : '') + ' picker-input'}
        role="combobox"
        aria-label={label}
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && shown[hi] ? `${listId}-${hi}` : undefined}
        placeholder={current?.label ?? placeholder}
        value={open ? q : current?.label ?? ''}
        onFocus={() => { setOpen(true); setQ(''); }}
        onClick={() => setOpen(true)}
        onBlur={() => { setOpen(false); setQ(''); }}
        onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        onKeyDown={key}
      />
      <svg className="picker-caret" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
      {open && (
        <ul ref={list} id={listId} role="listbox" className="picker-list" onMouseDown={(e) => e.preventDefault()}>
          {shown.length === 0 && <li className="picker-empty">No category matches "{q}"</li>}
          {shown.map((o, i) => (
            <li key={o.id} id={`${listId}-${i}`} data-i={i} role="option" aria-selected={o.id === value}
              className={(i === hi ? 'hi ' : '') + (o.id === value ? 'sel ' : '') + (special.includes(o) ? 'special' : '')}
              onMouseEnter={() => setHi(i)} onClick={() => pick(o)}>
              {o.label}{o.hint && <span className="muted small"> {o.hint}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
