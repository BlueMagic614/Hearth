import { useState } from 'react';
import { api } from '../api';
import { Tip, usd, useLoad } from './ui';
import { CategoryPicker } from './CategoryPicker';

export interface ReviewItem {
  id: string; date: string; amount_cents: number; merchant: string; pending: boolean; bank_category: string | null;
  suggested_category_id: string | null; suggested_name: string | null; confidence: number | null; about?: string | null;
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
    setNote(r.alsoSorted ? `Also sorted ${r.alsoSorted} more from ${t.merchant.replace(/[.!?]+$/, '')}.` : null);
  });

  const items = review.data?.items ?? [];
  if (!items.length) return null;
  const withGuess = items.filter((i) => i.suggested_category_id);
  // One row per payee: sorting one sorts the rest of that payee's purchases.
  const groups: (ReviewItem & { count: number; first: string })[] = [];
  const byKey = new Map<string, (typeof groups)[number]>();
  for (const i of items) {
    const key = i.merchant.toLowerCase().replace(/[^a-z]/g, '') || i.id;
    const g = byKey.get(key);
    // Items arrive newest first, so the row shows the latest purchase and how far back the others go.
    if (g) { g.count++; g.first = i.date; continue; }
    const n = { ...i, count: 1, first: i.date };
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
          <span style={{ flex: '1 1 150px', fontWeight: 500 }}>{t.merchant}{t.pending && <span className="pending-badge">Pending</span>}{t.count > 1 && <span className="muted small" style={{ fontWeight: 400 }}> · {t.count} purchases since {day(t.first)}</span>}
            {t.about && <span className="about-line">{t.about}</span>}</span>
          <span style={{ width: 88, textAlign: 'right', fontWeight: 500 }} className={t.amount_cents > 0 ? 'good' : undefined} title={t.count > 1 ? 'Latest purchase' : undefined}>{t.amount_cents > 0 ? '+' : ''}{usd(Math.abs(t.amount_cents), true)}</span>
          {t.suggested_category_id && (
            <button className="btn sm accent" disabled={busy} onClick={() => choose(t, t.suggested_category_id!)} title={t.confidence !== null ? `Hearth is about ${Math.round(t.confidence * 100)}% sure` : undefined}>
              {t.suggested_name}
            </button>
          )}
          <CategoryPicker compact style={{ flex: '0 1 240px' }} label={`Choose a category for ${t.merchant}`} value={null} options={options}
            special={[{ id: '__transfer', label: 'Transfer between our accounts' }, { id: '__income', label: 'Income (pay, deposits)' }]} placeholder={t.suggested_category_id ? 'Something else… (type to search)' : 'Type or choose a category…'}
            onChange={(v) => { if (!busy) choose(t, v); }} />
        </div>
      ))}
      {groups.length > 6 && <button className="btn sm ghost" style={{ marginTop: 6 }} onClick={() => setAll(!all)}>{all ? 'Show fewer' : `Show all ${groups.length} payees`}</button>}
    </div>
  );
}
