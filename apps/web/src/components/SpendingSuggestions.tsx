import { useEffect, useMemo, useState } from 'react';
import { parseCents } from '@hearth/core';
import { api } from '../api';
import { Tip, usd } from './ui';

interface Item { categoryId: string; path: string; current: number; monthly: number; suggested: number; count: number }
type Suggestions =
  | { ready: false; reason: string }
  | { ready: true; start: string; end: string; days: number; unsorted: { count: number; total: number }; items: Item[] };

const fmt = (d: string) => new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

/**
 * "Set from spending": everyday categories with what you actually spent per month over the last 90 days.
 * Nothing changes until you press Apply; each row can be edited or left out.
 */
export function SpendingSuggestions({ month, leftToAssign, onClose, onApplied }: { month: string; leftToAssign: number; onClose: () => void; onApplied: (n: number) => void }) {
  const [data, setData] = useState<Suggestions | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [rows, setRows] = useState<Record<string, { on: boolean; value: string }>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.get<Suggestions>(`/api/budget/suggestions?month=${month}`).then((d) => {
      setData(d);
      if (d.ready) {
        // Pre-tick rows that would change by at least $10 and have real spending behind them.
        setRows(Object.fromEntries(d.items.map((i) => [i.categoryId, { on: i.count > 0 && Math.abs(i.suggested - i.current) >= 1000, value: (i.suggested / 100).toFixed(0) }])));
      }
    }).catch((e: Error) => setErr(e.message));
  }, [month]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [onClose]);

  const chosen = useMemo(() => {
    if (!data?.ready) return [];
    return data.items.flatMap((i) => {
      const r = rows[i.categoryId];
      if (!r?.on) return [];
      const cents = parseCents(r.value);
      return cents === null || cents < 0 ? [] : [{ item: i, cents }];
    });
  }, [data, rows]);
  const delta = chosen.reduce((s, c) => s + (c.cents - c.item.current), 0);
  const after = leftToAssign - delta;

  const apply = async () => {
    setSaving(true);
    try {
      await api.post('/api/budget/apply', { month, items: chosen.map((c) => ({ categoryId: c.item.categoryId, amount: c.cents })) });
      onApplied(chosen.length);
    } catch (e) { setErr((e as Error).message); setSaving(false); }
  };

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div className="card modal wide screen" role="dialog" aria-modal="true" aria-labelledby="sugg-title" onClick={(x) => x.stopPropagation()}>
        <h2 id="sugg-title">Set everyday budgets from your spending</h2>
        {err && <div className="notice warn" style={{ marginTop: 10 }}>{err}</div>}
        {!data && !err && <div className="muted" style={{ marginTop: 10 }}>Adding up your spending…</div>}
        {data && !data.ready && <p className="muted" style={{ marginTop: 10 }}>{data.reason}</p>}
        {data?.ready && (
          <>
            <p className="muted small" style={{ marginTop: 6 }}>
              Monthly average from {fmt(data.start)} to {fmt(data.end)} ({data.days} days), rounded up to the next $5. Applies from {new Date(month + '-15').toLocaleDateString('en-US', { month: 'long' })} onward.
            </p>
            {data.unsorted.count > 0 && (
              <div className="notice warn" style={{ marginTop: 8 }}>
                {data.unsorted.count} purchases ({usd(data.unsorted.total)}) in this period aren't sorted yet, so some averages may be low. Sorting the review list first gives better numbers.
              </div>
            )}
            <div className="sugg-table" role="table">
              <div className="sugg-row head" role="row">
                <span role="columnheader" />
                <span role="columnheader">Category</span>
                <span role="columnheader" className="num">Spent / mo <Tip label="About spent per month" text="What you actually spent in this category, averaged to a month. Purchases sorted elsewhere or still unsorted aren't counted." /></span>
                <span role="columnheader" className="num">Planned now</span>
                <span role="columnheader" className="num">New plan</span>
              </div>
              {data.items.map((i) => {
                const r = rows[i.categoryId] ?? { on: false, value: '' };
                const set = (p: Partial<typeof r>) => setRows((x) => ({ ...x, [i.categoryId]: { ...r, ...p } }));
                return (
                  <label key={i.categoryId} className={'sugg-row' + (r.on ? '' : ' off')} role="row">
                    <input type="checkbox" checked={r.on} onChange={(e) => set({ on: e.target.checked })} style={{ accentColor: 'var(--accent)' }} aria-label={`Update ${i.path}`} />
                    <span className="sugg-name">{i.path.split(' › ').pop()}<span className="muted small"> {i.count ? `· ${i.count} purchase${i.count === 1 ? '' : 's'}` : '· nothing spent'}</span></span>
                    <span className="num">{usd(i.monthly)}</span>
                    <span className="num muted">{usd(i.current)}</span>
                    <span className="num"><input className="input sm num" inputMode="decimal" value={r.value} aria-label={`New plan for ${i.path}`}
                      onChange={(e) => set({ value: e.target.value, on: true })} onFocus={(e) => e.target.select()} style={{ width: 84 }} /></span>
                  </label>
                );
              })}
            </div>
            <div className="modal-foot">
              <span className="small" style={{ flex: '1 1 220px' }}>
                {chosen.length} change{chosen.length === 1 ? '' : 's'} · left to assign would be{' '}
                <b className={after === 0 ? 'good' : 'warn'}>{after < 0 ? '−' : ''}{usd(Math.abs(after), true)}</b>
              </span>
              <button className="btn ghost" onClick={onClose}>Cancel</button>
              <button className="btn accent" disabled={!chosen.length || saving} onClick={apply}>{saving ? 'Saving…' : 'Apply'}</button>
            </div>
          </>
        )}
        {data && !data.ready && <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}><button className="btn" onClick={onClose}>Close</button></div>}
      </div>
    </div>
  );
}
