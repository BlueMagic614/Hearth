import { useState } from 'react';
import { parseCents } from '@hearth/core';
import { api } from '../api';
import { Tip, usd, useLoad } from './ui';

interface Envelope { categoryId: string; name: string; planned: number; filled: number }
interface Option { destination: 'checking' | 'goal' | 'loan'; targetId: string | null; targetName: string; reason: string; impact?: string }
export interface CashView {
  month: string; envelopes: Envelope[]; toFill: number; plannedCash: number; unassigned: number; leftoverCounted: number;
  withdrawals: { id: string; date: string; amount_cents: number; merchant: string; pending: boolean; fills: { categoryId: string | null; name: string | null; amount: number }[] }[];
  leftovers: { balance: number; best: Option | null; options: Option[] };
}

const day = (d: string) => new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const dollars = (c: number) => (c / 100).toFixed(c % 100 ? 2 : 0);

/**
 * Cash envelopes for the month (fill-and-forget): what's planned in cash, what's been pulled and how it was split,
 * what's still to pull, and the Leftovers fund with Hearth's recommendation for it.
 */
export function CashCard({ month, onChange }: { month: string; onChange: () => void }) {
  const cash = useLoad(() => api.get<CashView>(`/api/cash?month=${month}`), [month]);
  const [splitting, setSplitting] = useState<CashView['withdrawals'][number] | null>(null);
  const [counting, setCounting] = useState(false);
  const [pick, setPick] = useState(0);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const changed = () => { cash.reload(); onChange(); };

  const c = cash.data;
  if (!c || (!c.envelopes.length && !c.withdrawals.length && !c.leftovers.balance)) return null;
  const filled = c.envelopes.reduce((s, e) => s + e.filled, 0);
  const opt = c.leftovers.options[pick] ?? c.leftovers.best;
  const monthName = new Date(month + '-15T12:00:00').toLocaleDateString('en-US', { month: 'long' });

  const move = async () => {
    if (!opt) return;
    setErr(null);
    try {
      const r = await api.post<{ to: string }>('/api/cash/leftovers/move', { amount: c.leftovers.balance, destination: opt.destination, targetId: opt.targetId });
      setMsg(`Moved ${usd(c.leftovers.balance, true)} of leftovers to ${r.to}.${opt.destination === 'checking' ? ' Deposit the cash at Kemba.' : opt.destination === 'loan' ? ` Make the extra payment to ${r.to}; the payoff plan already counts it.` : ' Move the cash into savings.'}`);
      setPick(0);
      changed();
    } catch (e) { setErr((e as Error).message); }
  };

  return (
    <div className="card cash-card">
      <div className="cash-head">
        <h2>Cash envelopes <span className="muted" style={{ fontWeight: 400 }}>· {monthName}</span>
          <Tip label="About cash envelopes" text="ATM withdrawals fill your envelopes instead of counting as spending. Filling an envelope counts as spending that category's money for the month. Count what's left at month end and it goes to the Leftovers fund." />
        </h2>
        <div className="cash-stats">
          <span><b>{usd(c.plannedCash)}</b> planned in cash</span>
          <span><b>{usd(filled)}</b> filled</span>
          <span className={c.toFill ? 'warn' : 'good'}><b>{usd(c.toFill)}</b> still to pull</span>
        </div>
      </div>

      {c.envelopes.length > 0 && (
        <div className="envelopes">
          {c.envelopes.map((e) => (
            <div key={e.categoryId} className="envelope" title={`${e.name}: ${usd(e.filled, true)} of ${usd(e.planned, true)} filled`}>
              <span className="env-name">{e.name}</span>
              <span className="env-num">{usd(e.filled)} <span className="muted">/ {usd(e.planned)}</span></span>
              <span className="env-bar"><span style={{ width: `${Math.min(100, e.planned ? (e.filled / e.planned) * 100 : 0)}%` }} /></span>
            </div>
          ))}
        </div>
      )}

      {c.withdrawals.length > 0 && (
        <div className="cash-list">
          {c.withdrawals.map((w) => (
            <div key={w.id} className="cash-row">
              <span className="muted" style={{ width: 52 }}>{day(w.date)}</span>
              <span style={{ fontWeight: 500, width: 80 }}>{usd(-w.amount_cents, true)}</span>
              <span className="muted small" style={{ flex: 1, minWidth: 0 }}>
                {w.pending ? 'Pending at Kemba, splits when it posts' : w.fills.map((f) => `${f.name ?? 'Not in an envelope'} ${usd(f.amount)}`).join(' · ')}
              </span>
              {!w.pending && <button className="btn sm" onClick={() => setSplitting(w)}>Edit split</button>}
            </div>
          ))}
        </div>
      )}
      {c.unassigned > 0 && <div className="notice warn">{usd(c.unassigned, true)} of this month's cash isn't in an envelope yet. Edit a withdrawal's split to give it a job.</div>}

      <div className="leftovers">
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
          <span style={{ flex: '1 1 220px' }}><b>Leftovers fund: {usd(c.leftovers.balance, true)}</b>
            {c.leftoverCounted > 0 && <span className="muted small"> · {usd(c.leftoverCounted, true)} counted for {monthName}</span>}
            <Tip label="About the Leftovers fund" text="Cash still in the envelopes at month end. Counting it takes it back out of those categories (so spending is accurate) and holds it here until you decide where it goes." />
          </span>
          <button className="btn sm" onClick={() => setCounting(true)}>Count leftover cash</button>
        </div>
        {c.leftovers.balance > 0 && opt && (
          <div className="recommend">
            <div className="small muted">{pick === 0 ? "Hearth's recommendation" : 'Another option'}</div>
            <div><b>{opt.destination === 'checking' ? 'Deposit in checking' : `Put it toward ${opt.targetName}`}</b>: {opt.reason}{opt.impact ? ` ${opt.impact}` : ''}</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
              <button className="btn sm accent" onClick={move}>Move {usd(c.leftovers.balance, true)} to {opt.destination === 'checking' ? 'checking' : opt.targetName}</button>
              {c.leftovers.options.length > 1 && (
                <select className="input sm" style={{ width: 'auto' }} value={pick} onChange={(e) => setPick(Number(e.target.value))} aria-label="Other places for leftovers">
                  {c.leftovers.options.map((o, i) => <option key={i} value={i}>{i === 0 ? 'Recommended: ' : ''}{o.destination === 'checking' ? 'Checking' : o.targetName}</option>)}
                </select>
              )}
            </div>
          </div>
        )}
        {msg && <div className="notice good">{msg}</div>}
        {err && <div className="notice warn">{err}</div>}
      </div>

      {splitting && <SplitEditor w={splitting} envelopes={c.envelopes} onClose={() => setSplitting(null)} onSaved={() => { setSplitting(null); changed(); }} />}
      {counting && <CountLeftovers month={month} envelopes={c.envelopes} onClose={() => setCounting(false)} onSaved={() => { setCounting(false); changed(); }} />}
    </div>
  );
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div className="card modal screen" role="dialog" aria-modal="true" aria-label={title} onClick={(x) => x.stopPropagation()}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

function SplitEditor({ w, envelopes, onClose, onSaved }: { w: CashView['withdrawals'][number]; envelopes: Envelope[]; onClose: () => void; onSaved: () => void }) {
  const total = -w.amount_cents;
  const [vals, setVals] = useState<Record<string, string>>(() => Object.fromEntries(envelopes.map((e) => [e.categoryId, dollars(w.fills.find((f) => f.categoryId === e.categoryId)?.amount ?? 0)])));
  const [err, setErr] = useState<string | null>(null);
  const assigned = Object.values(vals).reduce((s, v) => s + parseCents(v || '0'), 0);
  const rest = total - assigned;
  const save = async () => {
    const parts = envelopes.map((e) => ({ categoryId: e.categoryId as string | null, amount: parseCents(vals[e.categoryId] || '0') })).filter((p) => p.amount > 0);
    if (rest > 0) parts.push({ categoryId: null, amount: rest });
    try { await api.put(`/api/cash/withdrawals/${w.id}`, { parts }); onSaved(); } catch (e) { setErr((e as Error).message); }
  };
  return (
    <Modal title={`Split ${usd(total, true)} from ${day(w.date)}`} onClose={onClose}>
      <div className="split-list">
        {envelopes.map((e) => (
          <label key={e.categoryId} className="split-row">
            <span>{e.name} <span className="muted small">planned {usd(e.planned)}</span></span>
            <input className="input sm num" inputMode="decimal" style={{ width: 96 }} value={vals[e.categoryId] ?? ''} onFocus={(x) => x.target.select()}
              onChange={(x) => setVals({ ...vals, [e.categoryId]: x.target.value })} aria-label={`Cash for ${e.name}`} />
          </label>
        ))}
      </div>
      <div className={'small ' + (rest < 0 ? 'warn' : 'muted')} style={{ marginTop: 8 }}>
        {rest === 0 ? 'Every dollar has an envelope.' : rest > 0 ? `${usd(rest, true)} not in an envelope yet (kept as unassigned cash).` : `${usd(-rest, true)} more than the withdrawal.`}
      </div>
      {err && <div className="notice warn" style={{ marginTop: 8 }}>{err}</div>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn accent" disabled={rest < 0} onClick={save}>Save split</button>
      </div>
    </Modal>
  );
}

function CountLeftovers({ month, envelopes, onClose, onSaved }: { month: string; envelopes: Envelope[]; onClose: () => void; onSaved: () => void }) {
  const [vals, setVals] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const total = Object.values(vals).reduce((s, v) => s + parseCents(v || '0'), 0);
  const save = async () => {
    try {
      await api.post('/api/cash/leftovers', { month, items: envelopes.map((e) => ({ categoryId: e.categoryId, amount: parseCents(vals[e.categoryId] || '0') })).filter((i) => i.amount > 0) });
      onSaved();
    } catch (e) { setErr((e as Error).message); }
  };
  return (
    <Modal title="Count leftover cash" onClose={onClose}>
      <p className="muted small" style={{ marginTop: 4 }}>Enter what's still in each envelope. It comes back out of that category's spending and into the Leftovers fund. Counting again replaces this month's count.</p>
      <div className="split-list">
        {envelopes.map((e) => (
          <label key={e.categoryId} className="split-row">
            <span>{e.name} <span className="muted small">filled {usd(e.filled)}</span></span>
            <input className="input sm num" inputMode="decimal" placeholder="$0" style={{ width: 96 }} value={vals[e.categoryId] ?? ''}
              onChange={(x) => setVals({ ...vals, [e.categoryId]: x.target.value })} aria-label={`Left in ${e.name}`} />
          </label>
        ))}
      </div>
      {err && <div className="notice warn" style={{ marginTop: 8 }}>{err}</div>}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
        <span className="small" style={{ flex: 1 }}>Total leftover: <b>{usd(total, true)}</b></span>
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn accent" onClick={save}>Add to Leftovers</button>
      </div>
    </Modal>
  );
}
