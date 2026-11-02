import { useMemo, useState } from 'react';
import { parseCents, type CategoryNode } from '@hearth/core';
import { api, type BudgetView, type Txn } from '../api';
import { ReviewList } from '../components/ReviewList';
import { CategoryPicker } from '../components/CategoryPicker';
import { TagEditor } from '../components/TagEditor';
import { MonthPicker, PageHead, Tip, todayISO, useLoad, usd } from '../components/ui';

/** Every leaf category with its path, e.g. "Other › Hobbies › Music gear". */
export function leafOptions(tree: CategoryNode[]): { id: string; label: string }[] {
  const out: { id: string; label: string }[] = [];
  const walk = (nodes: CategoryNode[], path: string[]) => {
    for (const n of nodes) {
      if (n.children.length) walk(n.children, [...path, n.name]);
      else out.push({ id: n.id, label: [...path, n.name].join(' › ') });
    }
  };
  walk(tree, []);
  return out;
}

/** The household's Miscellaneous category (kind 'misc'). */
export function miscId(tree: CategoryNode[]): string | undefined {
  for (const n of tree) { if (n.kind === 'misc' && !n.children.length) return n.id; const f = miscId(n.children); if (f) return f; }
  return undefined;
}

export function Transactions({ month, setMonth }: { month: string; setMonth: (m: string) => void }) {
  const txns = useLoad(() => api.get<Txn[]>(`/api/transactions?month=${month}`), [month]);
  const budget = useLoad(() => api.get<BudgetView>(`/api/budget?month=${month}`), [month]);
  const [form, setForm] = useState({ date: todayISO(), merchant: '', amount: '', categoryId: '', income: false });
  const [err, setErr] = useState<string | null>(null);
  const [askTag, setAskTag] = useState<string | null>(null);
  const options = useMemo(() => (budget.data ? leafOptions(budget.data.tree) : []), [budget.data]);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    const cents = parseCents(form.amount);
    if (!form.merchant.trim() || !cents) { setErr('Add who it was and how much.'); return; }
    try {
      await api.post('/api/transactions', { date: form.date, merchant: form.merchant, amount: (form.income ? -cents : cents) / 100, categoryId: form.categoryId || null });
      setForm({ ...form, merchant: '', amount: '' });
      txns.reload();
    } catch (x) { setErr((x as Error).message); }
  };

  return (
    <div className="stack screen">
      <PageHead sub="From Kemba, plus anything you add by hand" title="Transactions"><MonthPicker month={month} onChange={setMonth} /></PageHead>

      <form className="card" onSubmit={add} style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'flex-end' }}>
        <label className="field">Date<input className="input" type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} /></label>
        <label className="field" style={{ flex: '2 1 180px' }}>Who<input className="input" placeholder="Kroger, Speedway…" value={form.merchant} onChange={(e) => setForm({ ...form, merchant: e.target.value })} /></label>
        <label className="field" style={{ flex: '1 1 110px' }}>Amount<input className="input num" inputMode="decimal" placeholder="$" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} /></label>
        <label className="field" style={{ flex: '2 1 220px' }}>Category
          <CategoryPicker label="Category" value={form.categoryId} options={options} special={[{ id: '', label: 'Choose later' }]} placeholder="Choose later"
            onChange={(id) => setForm({ ...form, categoryId: id })} />
        </label>
        <label className="small muted" style={{ display: 'flex', alignItems: 'center', gap: 6, height: 38 }}>
          <input type="checkbox" checked={form.income} onChange={(e) => setForm({ ...form, income: e.target.checked })} style={{ accentColor: 'var(--accent)' }} /> Money in
          <Tip label="About money in" text="Tick this for refunds, deposits and anything that adds to your balance. Paychecks come in automatically once Kemba is connected." />
        </label>
        <button className="btn primary" type="submit">Add</button>
        {err && <div className="notice warn" style={{ flexBasis: '100%' }}>{err}</div>}
      </form>

      <ReviewList options={options} onChange={txns.reload} />

      <div className="card" style={{ padding: '8px 22px 12px' }}>
        {txns.data && txns.data.length === 0 && <div className="muted" style={{ padding: '18px 0' }}>Nothing yet this month. Connect Kemba under Accounts, or add a purchase above.</div>}
        {txns.data?.map((t) => (
          <div key={t.id} className="list-row" style={{ flexWrap: 'wrap' }}>
            <span className="muted" style={{ width: 56, fontSize: 13 }}>{new Date(t.date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
            <span style={{ flex: '1 1 160px', fontWeight: 500 }} title={t.about ?? undefined}>{t.merchant}{t.pending && <span className="pending-badge" title="Still pending at Kemba; the amount or date can change when it posts">Pending</span>}{['rule', 'agent', 'bank', 'claude'].includes(t.source) && t.category_id && <span className="pending-badge" title={`Sorted automatically (${{ rule: 'a past choice or a matching bill', agent: 'learned from your choices', bank: "Kemba's category", claude: 'Claude' }[t.source]}). Change it if it's wrong and Hearth will remember.`}>Auto</span>}</span>
            {t.flow === 'cash' ? (
              <span className="small muted" style={{ flex: '1 1 200px', maxWidth: 280 }}>
                Cash withdrawal: fills your envelopes ·{' '}
                <button className="btn sm ghost" style={{ padding: 0, height: 'auto', color: 'var(--accent)' }} onClick={() => api.patch(`/api/transactions/${t.id}`, { flow: 'spend' }).then(txns.reload)}>Not cash?</button>
              </span>
            ) : (
            <CategoryPicker compact style={{ flex: '1 1 200px', maxWidth: 280 }} label={`Category for ${t.merchant}`}
              value={t.category_id ?? (t.flow && t.flow !== 'spend' ? `__${t.flow}` : '')} options={options}
              special={[{ id: '', label: t.needs_review ? 'Needs a look' : 'Uncategorized' }, ...[{ id: '__transfer', label: 'Transfer between our accounts' }, { id: '__income', label: 'Income (pay, deposits)' }, { id: '__cash', label: 'Cash withdrawal (fills envelopes)' }]]} placeholder="Uncategorized"
              onChange={(v) => {
                const body = v === '__transfer' || v === '__income' || v === '__cash' ? { flow: v.slice(2), categoryId: null } : { categoryId: v || null, flow: 'spend' };
                api.patch<{ tag?: string | null }>(`/api/transactions/${t.id}`, body).then((r) => {
                  // Put into Miscellaneous with no suggested tag: ask for one right there.
                  if (v && budget.data && miscId(budget.data.tree) === v && !r.tag) setAskTag(t.id);
                  txns.reload();
                });
              }} />
            )}
            {t.category_kind === 'misc' && <TagEditor id={t.id} tag={t.tag} source={t.tag_source} prompt={askTag === t.id} onSaved={() => { setAskTag(null); txns.reload(); }} />}
            <span style={{ width: 100, textAlign: 'right', fontWeight: 500 }} className={t.amount_cents > 0 ? 'good' : undefined}>{t.amount_cents > 0 ? '+' : ''}{usd(Math.abs(t.amount_cents), true)}</span>
            <button className="icon-btn danger" aria-label={`Delete ${t.merchant}`} onClick={() => api.del(`/api/transactions/${t.id}`).then(txns.reload)}>×</button>
          </div>
        ))}
      </div>
    </div>
  );
}
