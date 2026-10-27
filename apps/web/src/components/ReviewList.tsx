import { useState } from 'react';
import { api } from '../api';
import { Tip, usd, useLoad } from './ui';

export interface ReviewItem {
  id: string; date: string; amount_cents: number; merchant: string; pending: boolean; bank_category: string | null;
  suggested_category_id: string | null; suggested_name: string | null; confidence: number | null;
}

const day = (d: string) => new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

/**
 * Purchases the agent wasn't sure about. One tap accepts its guess; choosing a category or "transfer" teaches it,
 * and every other purchase from the same payee follows along.
 */
export function ReviewList({ options, onChange }: { options: { id: string; label: string }[]; onChange: () => void }) {
  const review = useLoad(() => api.get<{ count: number; items: ReviewItem[] }>('/api/review'), []);
  const [all, setAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try { await fn(); } catch (e) { setNote((e as Error).message); }
    finally { setBusy(false); review.reload(); onChange(); }
  };
  const choose = (t: ReviewItem, value: string) => act(async () => {
    const body = value === '__transfer' ? { flow: 'transfer' } : value === '__income' ? { flow: 'income' } : { categoryId: value };
    const r = await api.patch<{ alsoSorted?: number }>(`/api/transactions/${t.id}`, body);
    setNote(r.alsoSorted ? `Also sorted ${r.alsoSorted} more from ${t.merchant}.` : null);
  });

  const items = review.data?.items ?? [];
  if (!items.length) return null;
  const withGuess = items.filter((i) => i.suggested_category_id);
  // One row per payee: sorting one sorts the rest of that payee's purchases.
  const groups: (ReviewItem & { count: number; total: number })[] = [];
  const byKey = new Map<string, (typeof groups)[number]>();
  for (const i of items) {
    const key = i.merchant.toLowerCase().replace(/[^a-z]/g, '') || i.id;
    const g = byKey.get(key);
    if (g) { g.count++; g.total += i.amount_cents; continue; }
    const n = { ...i, count: 1, total: i.amount_cents };
    byKey.set(key, n);
    groups.push(n);
  }
  const shown = all ? groups : groups.slice(0, 6);

  return (
    <div className="card">
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, marginBottom: 6 }}>
        <h2 style={{ flex: '1 1 200px' }}>Needs a look <span className="muted" style={{ fontWeight: 400 }}>· {items.length}</span>
          <Tip label="About the review list" text="Purchases from the last 90 days that Hearth couldn't sort with confidence. Accept its guess or pick the right category; every other purchase from the same payee follows, and Hearth remembers next time." />
        </h2>
        {withGuess.length > 1 && <button className="btn sm" disabled={busy} onClick={() => act(() => api.post('/api/review/accept', { ids: withGuess.map((i) => i.id) }))}>Accept all {withGuess.length} guesses</button>}
      </div>
      {note && <div className="notice good" style={{ marginBottom: 6 }}>{note}</div>}
      {shown.map((t) => (
        <div key={t.id} className="review-row">
          <span className="muted" style={{ width: 52, fontSize: 13 }}>{day(t.date)}</span>
          <span style={{ flex: '1 1 150px', fontWeight: 500 }}>{t.merchant}{t.pending && <span className="pending-badge">Pending</span>}{t.count > 1 && <span className="muted small" style={{ fontWeight: 400 }}> · {t.count} purchases</span>}</span>
          <span style={{ width: 88, textAlign: 'right', fontWeight: 500 }} className={t.total > 0 ? 'good' : undefined} title={t.count > 1 ? 'Total of these purchases' : undefined}>{t.total > 0 ? '+' : ''}{usd(Math.abs(t.total), true)}</span>
          {t.suggested_category_id && (
            <button className="btn sm accent" disabled={busy} onClick={() => choose(t, t.suggested_category_id!)} title={t.confidence !== null ? `Hearth is about ${Math.round(t.confidence * 100)}% sure` : undefined}>
              {t.suggested_name}
            </button>
          )}
          <select className="input sm" style={{ flex: '0 1 220px' }} value="" disabled={busy} aria-label={`Choose a category for ${t.merchant}`} onChange={(e) => e.target.value && choose(t, e.target.value)}>
            <option value="">{t.suggested_category_id ? 'Something else…' : 'Choose a category…'}</option>
            <option value="__transfer">Transfer between our accounts</option>
            <option value="__income">Income (pay, deposits)</option>
            {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
        </div>
      ))}
      {groups.length > 6 && <button className="btn sm ghost" style={{ marginTop: 6 }} onClick={() => setAll(!all)}>{all ? 'Show fewer' : `Show all ${groups.length} payees`}</button>}
    </div>
  );
}
