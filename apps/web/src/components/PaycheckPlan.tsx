import { useState } from 'react';
import { api } from '../api';
import { Tip, todayISO, usd, useLoad } from './ui';

export interface PlanItem { scheduleId: string; categoryId: string | null; name: string; date: string; amount: number; kind: 'bill' | 'save' | 'cash' | 'card'; variable: boolean }
interface Check { person: string; payDate: string; amount: number }
interface Step { from: string; to: string; items: PlanItem[]; outflow: number; leaves: number }
export interface Half { id: string; from: string; to: string; first: Check; second: Check | null; step1: Step; step2: (Step & { pool: number }) | null; carryIn: number; income: number; outflow: number; end: number }
export interface PaycheckView {
  month: string; halves: Half[]; payers: Record<string, string>;
  unscheduled: { categoryId: string; name: string; amount: number; kind: string | null }[];
  assigned: { categoryId: string; name: string; amount: number; kind: string | null; payDay: number }[];
  paydays: { person: string; day: number; amount: number }[];
}

const fmt = (d: string, o: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' }) => new Date(d + 'T12:00:00').toLocaleDateString('en-US', o);
const wk = (d: string) => fmt(d, { weekday: 'short', month: 'short', day: 'numeric' });
const ord = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'}`;
const signed = (c: number) => (c < 0 ? `−${usd(-c)}` : usd(c));

/** The half (and step) of the month we're living in today. */
export function currentHalf(plan: PaycheckView | null | undefined, today = todayISO()) {
  const h = plan?.halves.find((x) => today >= x.first.payDate && today <= x.to);
  if (!h) return null;
  const step = h.second && today >= h.second.payDate ? 2 : 1;
  return { half: h, step };
}

function Items({ items, today }: { items: PlanItem[]; today: string }) {
  const [open, setOpen] = useState(false);
  const bills = items.filter((i) => i.kind === 'bill' || i.kind === 'save').length;
  return (
    <div>
      <button className="btn sm ghost" style={{ padding: 0, height: 'auto', color: 'var(--accent)' }} onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? 'Hide the list' : `Show what's in it (${bills} bill${bills === 1 ? '' : 's'}${items.some((i) => i.kind === 'cash') ? ' + cash' : ''})`}
      </button>
      {open && (
        <ul className="pay-items">
          {items.map((i, k) => (
            <li key={k} className={i.date < today && i.kind !== 'cash' && i.kind !== 'card' ? 'done' : undefined}>
              <span className="muted">{i.kind === 'cash' || i.kind === 'card' ? '' : fmt(i.date)}</span>
              <span>{i.name}{i.variable && i.kind === 'bill' && <span className="muted small"> · varies</span>}{i.kind === 'save' && <span className="pending-badge cash-badge">saving</span>}</span>
              <span className="num">{usd(i.amount)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Line({ label, value, kind }: { label: string; value: string; kind?: 'minus' | 'total' | 'good' | 'bad' }) {
  return (
    <div className={'eq-line' + (kind ? ` ${kind}` : '')}>
      <span>{label}</span><span className="num">{value}</span>
    </div>
  );
}

/**
 * The month in two halves, the way the household runs it: Renee's check alone until Jason's payday, then both
 * checks pooled until Renee's next payday. Simple equations first; the bill lists open on request.
 */
export function PaycheckPlan({ month }: { month: string }) {
  const plan = useLoad(() => api.get<PaycheckView>(`/api/paychecks?month=${month}`), [month]);
  const today = todayISO();
  const p = plan.data;
  if (plan.error) return <div className="notice warn">{plan.error}</div>;
  if (!p) return <div className="muted">Lining up paychecks…</div>;
  const now = currentHalf(p, today);

  return (
    <div className="stack">
      <div className="notice good">
        <span>The month runs in two halves. <b>Step 1:</b> the first check of each half pays everything up to and including the next payday. <b>Step 2:</b> whatever's left of it, plus the second check, pays everything until the next half starts. A bill due on a payday is paid by the money you already have. Tithe and savings moves come out of the check that lands that day.</span>
      </div>

      {p.halves.map((h) => {
        const a = h.first, b = h.second;
        const live = now?.half.id === h.id;
        const s1ok = h.step1.leaves >= 0;
        const s1covered = !s1ok && h.step1.leaves + h.carryIn >= 0;
        return (
          <section key={h.id} className={'card half-card' + (live ? ' live' : '') + (h.to < today ? ' past' : '')} aria-label={`${fmt(h.first.payDate)} to ${fmt(h.to)}`}>
            <header className="half-head">
              <div>
                <h2>{fmt(a.payDate)} – {fmt(h.to)}{live && <span className="pending-badge cash-badge" style={{ marginLeft: 8 }}>you are here</span>}</h2>
                <div className="small muted">{a.person} {usd(a.amount)} on {wk(a.payDate)}{b ? ` + ${b.person} ${usd(b.amount)} on ${wk(b.payDate)}` : ''} = {usd(h.income)}</div>
              </div>
              <div className={'half-end ' + (h.end >= 0 ? 'good' : 'bad')}>
                <span className="small">{h.end >= 0 ? `Left on ${fmt(h.to)}` : `Short by ${fmt(h.to)}`}</span>
                <b>{usd(Math.abs(h.end))}</b>
              </div>
            </header>

            <div className="half-steps">
              <div className={'step' + (live && now?.step === 1 ? ' here' : '')}>
                <div className="step-title"><span className="step-n">1</span>{a.person}'s check until {b ? `${b.person} is paid` : 'the next payday'} <span className="muted small">({fmt(h.step1.from)} – {fmt(h.step1.to)})</span></div>
                <Line label={`${a.person}'s check`} value={usd(a.amount)} />
                <Line label="Bills, tithe & cash until then" value={`−${usd(h.step1.outflow)}`} kind="minus" />
                <Line label={b ? 'Left for step 2' : 'Left over'} value={signed(h.step1.leaves)} kind={s1ok ? 'good' : 'bad'} />
                {!s1ok && (
                  <div className={'notice small ' + (s1covered ? 'good' : 'warn')}>
                    {a.person}'s check alone is {usd(-h.step1.leaves)} short before {b?.person ?? 'the next check'} is paid.
                    {s1covered ? ` The ${usd(h.carryIn)} carried over from the last half covers it.` : ' Move a bill past ' + fmt(h.step1.to) + ' or set money aside from the last half.'}
                  </div>
                )}
                <Items items={h.step1.items} today={today} />
              </div>

              {b && h.step2 && (
                <div className={'step' + (live && now?.step === 2 ? ' here' : '')}>
                  <div className="step-title"><span className="step-n">2</span>Both checks together until {a.person} is paid again <span className="muted small">({fmt(h.step2.from)} – {fmt(h.step2.to)})</span></div>
                  <Line label={`Left from ${a.person}'s check`} value={signed(h.step1.leaves)} />
                  <Line label={`+ ${b.person}'s check`} value={usd(b.amount)} />
                  {h.carryIn > 0 && <Line label="+ Left over from the last half" value={usd(h.carryIn)} />}
                  <Line label="= To work with" value={usd(h.step2.pool)} kind="total" />
                  <Line label="Bills, tithe & cash until then" value={`−${usd(h.step2.outflow)}`} kind="minus" />
                  <Line label={`Left on ${fmt(h.to)}`} value={signed(h.step2.leaves)} kind={h.step2.leaves >= 0 ? 'good' : 'bad'} />
                  {h.step2.leaves < 0 && <div className="notice warn small">Together the checks come up {usd(-h.step2.leaves)} short before {fmt(h.to)}. Move a bill into the next half, trim cash, or carry more over from the last half.</div>}
                  <Items items={h.step2.items} today={today} />
                </div>
              )}
            </div>
          </section>
        );
      })}

      <SavingsPlacement p={p} onChange={plan.reload} />
    </div>
  );
}

interface Proposal { placements: { categoryId: string; name: string; amount: number; payDay: number; person: string; reason: string }[]; after: { half: string; from: string; leftAtEnd: number; firstCheckAlone: number }[] }

/**
 * Savings moves and extra debt payments: which check pays each. Hearth can decide, balancing the halves and keeping
 * the first check of each half free for bills; the proposal is shown first and saved only on Apply.
 */
function SavingsPlacement({ p, onChange }: { p: PaycheckView; onChange: () => void }) {
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const items = [...p.unscheduled.map((u) => ({ ...u, payDay: null as number | null })), ...p.assigned];
  if (!items.length) return null;
  const who = (day: number) => p.paydays.find((d) => d.day === day);
  const decide = async (apply: boolean) => {
    setBusy(true); setErr(null);
    try {
      const r = await api.post<Proposal>('/api/paychecks/auto', { month: p.month, apply });
      if (apply) { setProposal(null); onChange(); } else setProposal(r);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="card stack">
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
        <h2 style={{ flex: '1 1 220px' }}>Savings & extra payments
          <Tip label="About savings and extra payments" text="Monthly money with no bill date: savings moves and extra debt payments. Each comes out of one check every month. Let Hearth decide, or pick a check yourself. Anything not tied to a check is counted as left over, so the halves look better off than they are." />
        </h2>
        <button className="btn accent sm" disabled={busy} onClick={() => decide(false)}>{busy && !proposal ? 'Working it out…' : p.unscheduled.length ? 'Let Hearth decide' : 'Re-balance'}</button>
      </div>
      {err && <div className="notice warn">{err}</div>}

      {proposal && (
        <div className="proposal">
          <div className="small muted">Hearth suggests (nothing changes until you apply):</div>
          {proposal.placements.map((x) => (
            <div key={x.categoryId} className="proposal-row">
              <div><b>{x.name}</b> {usd(x.amount)} → <b>{x.person}'s {ord(x.payDay)}</b> check</div>
              <div className="small muted">{x.reason}</div>
            </div>
          ))}
          <div className="small" style={{ marginTop: 6 }}>
            Then each half ends with: {proposal.after.map((a) => `${a.half} ${a.leftAtEnd < 0 ? `short ${usd(-a.leftAtEnd)}` : usd(a.leftAtEnd)}`).join(' · ')}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn accent sm" disabled={busy} onClick={() => decide(true)}>Apply</button>
            <button className="btn ghost sm" onClick={() => setProposal(null)}>Not now</button>
          </div>
        </div>
      )}

      {items.map((u) => (
        <div key={u.categoryId} className="list-row">
          <span style={{ flex: 1 }}>{u.name}{u.payDay === null && <span className="pending-badge due-badge">not tied to a check</span>}</span>
          <span style={{ width: 90, textAlign: 'right', fontWeight: 500 }}>{usd(u.amount)}</span>
          <select className="input sm" style={{ width: 'auto' }} value={u.payDay ?? ''} aria-label={`Which check pays ${u.name}`}
            onChange={(e) => e.target.value && api.post('/api/paychecks/assign', { categoryId: u.categoryId, payDay: Number(e.target.value) }).then(onChange)}>
            {u.payDay === null && <option value="">Pay from…</option>}
            {p.paydays.map((d) => <option key={`${d.person}${d.day}`} value={d.day}>{d.person}'s {ord(d.day)} check</option>)}
            {u.payDay !== null && !who(u.payDay) && <option value={u.payDay}>Day {u.payDay}</option>}
          </select>
        </div>
      ))}
    </div>
  );
}
