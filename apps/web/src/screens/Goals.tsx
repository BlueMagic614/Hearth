import { useState } from 'react';
import { parseCents } from '@hearth/core';
import { api, type IncomeEvent, type PlanRun, type PlanView } from '../api';
import { PageHead, Switch, Tip, useLoad, usd } from '../components/ui';

const DEST: { id: IncomeEvent['destination']; label: string }[] = [
  { id: 'loans', label: 'Student loans' },
  { id: 'emergency', label: 'Emergency fund' },
  { id: 'split', label: 'Split' },
];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const mLabel = (m: string) => { const [y, mo] = m.split('-').map(Number) as [number, number]; return `${MONTHS[mo - 1]} ${y}`; };
const shiftMonth = (m: string, n: number) => { const [y, mo] = m.split('-').map(Number) as [number, number]; const i = y * 12 + mo - 1 + n; return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`; };

export function Goals() {
  const { data, error, reload } = useLoad(() => api.get<PlanView>('/api/plan'), []);
  const [plan, setPlan] = useState<PlanView | null>(null);
  const [draft, setDraft] = useState({ name: '', amount: '', month: '' });
  const p = plan ?? data;

  const save = async (fn: () => Promise<unknown>) => { await fn(); setPlan(null); reload(); };
  const patchEvent = (e: IncomeEvent, body: Record<string, unknown>) => save(() => api.patch(`/api/income-events/${e.id}`, body));

  if (error) return <div className="card">Couldn't load goals: {error}</div>;
  if (!p) return <div className="muted">Loading…</div>;

  const strategyCard = (run: PlanRun, title: string, desc: string, firstName: string) => {
    const active = p.strategy === run.strategy;
    return (
      <button key={run.strategy} onClick={() => api.put<PlanView>('/api/plan', { strategy: run.strategy }).then(setPlan)} aria-pressed={active}
        style={{ flex: '1 1 260px', textAlign: 'left', padding: '16px 18px', borderRadius: 12, border: `1.5px solid ${active ? 'var(--accent)' : 'var(--line)'}`, background: active ? 'var(--accent-wash)' : 'var(--surface)', cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 8, transition: 'border-color .2s, background .2s' }}>
        <span style={{ display: 'flex', justifyContent: 'space-between', fontSize: 15, fontWeight: 600 }}>{title}{active && <span className="small good">Current plan</span>}</span>
        <span className="muted" style={{ fontSize: 13, lineHeight: 1.45 }}>{desc}</span>
        <span style={{ display: 'flex', flexWrap: 'wrap', gap: 18, fontSize: 13 }}>
          <span><span className="small muted" style={{ display: 'block' }}>All paid off</span><strong>{run.doneLabel}</strong></span>
          <span><span className="small muted" style={{ display: 'block' }}>Total interest</span><strong>{usd(run.totalInterest)}</strong></span>
          <span><span className="small muted" style={{ display: 'block' }}>First loan gone</span><strong>{firstName} · {run.paidOff[firstName]}</strong></span>
        </span>
      </button>
    );
  };

  const savedVsWithout = p.withoutIncome.totalInterest - p.current.totalInterest;
  const totalDebt = p.loans.reduce((s, l) => s + l.balance, 0);

  return (
    <div className="stack screen">
      <PageHead sub="Debt payoff, savings and one-time income" title="Goals" />

      <div className="row-wrap">
        {p.goals.map((g) => (
          <div key={g.id} className="card grow" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div className="small muted" style={{ textTransform: 'uppercase', letterSpacing: '.05em' }}>{g.horizon}</div>
            <div style={{ fontSize: 17, fontWeight: 600 }}>{g.name}</div>
            {g.kind === 'debt' ? (
              <div style={{ fontSize: 13 }}><strong>{usd(totalDebt)}</strong> <span className="muted">across {p.loans.length} loans</span></div>
            ) : (
              <>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}><strong>{usd(g.saved_cents)} saved</strong><span className="muted">of {usd(g.target_cents)}</span></div>
                <div className="bar-track" style={{ height: 8 }}><div className="bar-fill" style={{ width: `${Math.min(100, (g.saved_cents / Math.max(1, g.target_cents)) * 100)}%` }} /></div>
              </>
            )}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', fontSize: 13 }}>
              <span className="muted">{g.kind === 'debt' ? `${usd(p.loans.reduce((s, l) => s + l.minPayment, 0) + p.extraCents)}/mo` : `${usd(g.monthly_cents)}/mo`}</span>
              <span>Lands <strong className="good">{g.etaLabel}</strong></span>
            </div>
          </div>
        ))}
      </div>

      <section className="card">
        <div className="stat-label" style={{ marginBottom: 4 }}>
          <h2 style={{ color: 'var(--ink)' }}>Student loan strategy</h2>
          <Tip label="About loan strategies" text="Both plans pay the same each month: the minimums plus your extra. They differ only in which loan gets the extra first. Calculated month by month with interest." />
        </div>
        <div className="muted" style={{ fontSize: 13, marginBottom: 14 }}>
          Minimums only: done {p.minimumsOnly.doneLabel} with {usd(p.minimumsOnly.totalInterest)} in interest. Your plan saves {usd(p.minimumsOnly.totalInterest - p.current.totalInterest)}.
        </div>
        <div className="row-wrap" style={{ gap: 12 }}>
          {strategyCard(p.snowball, 'Smallest balance first', `Snowball: ${p.snowball.order.join(', ')}. Quickest first win.`, p.snowball.order[0]!)}
          {strategyCard(p.avalanche, 'Highest rate first', `Avalanche: ${p.avalanche.order.join(', ')}. Least interest.`, p.avalanche.order[0]!)}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 16, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 14 }}>Extra each month</span>
          <button className="icon-btn" aria-label="Lower extra by $50" onClick={() => api.put<PlanView>('/api/plan', { extra: Math.max(0, p.extraCents - 5000) / 100 }).then(setPlan)}>−</button>
          <strong style={{ minWidth: 64, textAlign: 'center' }}>{usd(p.extraCents)}</strong>
          <button className="icon-btn" aria-label="Raise extra by $50" onClick={() => api.put<PlanView>('/api/plan', { extra: (p.extraCents + 5000) / 100 }).then(setPlan)}>+</button>
          <span className="small muted">Matches your “Extra on student loans” budget line; change both together.</span>
        </div>
      </section>

      <section className="card">
        <div className="stat-label" style={{ marginBottom: 4 }}>
          <h2 style={{ color: 'var(--ink)' }}>One-time income and raises</h2>
          <Tip label="About one-time income" text="Bonuses, stock sales, tax refunds, gifts. Enter what lands in the bank after taxes. Each one goes where you choose and every date updates." />
        </div>
        <div className="good" style={{ fontSize: 13, lineHeight: 1.5, marginBottom: 10 }}>
          {savedVsWithout > 0
            ? `With what's planned below, the loans are gone by ${p.current.doneLabel} instead of ${p.withoutIncome.doneLabel}, saving another ${usd(savedVsWithout)} in interest.`
            : 'Add a bonus, stock sale or refund to see how much sooner the loans are gone.'}
        </div>
        {p.incomeEvents.map((e) => (
          <div key={e.id} className="list-row" style={{ flexWrap: 'wrap', gap: '10px 16px', opacity: e.enabled ? 1 : 0.5 }}>
            <div style={{ flex: '1 1 200px', minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 600 }}>{e.name} <span className="muted" style={{ fontWeight: 400 }}>· {e.kind === 'raise' ? `from ${mLabel(e.month)}, monthly` : mLabel(e.month)}</span></div>
              {e.note && <div className="small muted" style={{ marginTop: 2 }}>{e.note}</div>}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <button className="icon-btn" aria-label="Lower amount" onClick={() => patchEvent(e, { amount: Math.max(0, e.amount_cents - (e.kind === 'raise' ? 5000 : 25000)) / 100 })}>−</button>
              <strong style={{ minWidth: 76, textAlign: 'center' }}>{usd(e.amount_cents)}{e.kind === 'raise' ? '/mo' : ''}</strong>
              <button className="icon-btn" aria-label="Raise amount" onClick={() => patchEvent(e, { amount: (e.amount_cents + (e.kind === 'raise' ? 5000 : 25000)) / 100 })}>+</button>
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              {DEST.map((d) => <button key={d.id} className="chip" aria-pressed={e.destination === d.id} onClick={() => patchEvent(e, { destination: d.id })}>{d.label}</button>)}
            </div>
            {e.kind === 'one_time' && (
              <label className="small muted" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <input type="checkbox" checked={e.repeats_yearly} onChange={() => patchEvent(e, { repeatsYearly: !e.repeats_yearly })} style={{ accentColor: 'var(--accent)' }} /> Every year
              </label>
            )}
            <Switch on={e.enabled} label={`Include ${e.name} in the plan`} onChange={(v) => patchEvent(e, { enabled: v })} />
            <button className="icon-btn danger" aria-label={`Remove ${e.name}`} onClick={() => save(() => api.del(`/api/income-events/${e.id}`))}>×</button>
          </div>
        ))}
        <form className="list-row" style={{ flexWrap: 'wrap', alignItems: 'flex-end', gap: 10 }}
          onSubmit={(ev) => { ev.preventDefault(); if (!parseCents(draft.amount)) return; const month = draft.month || shiftMonth(p.startMonth, 3); save(() => api.post('/api/income-events', { name: draft.name.trim() || 'One-time income', amount: draft.amount, month })).then(() => setDraft({ name: '', amount: '', month: '' })); }}>
          <label className="field" style={{ flex: '2 1 200px' }}>What is it?<input className="input" value={draft.name} placeholder="Tax refund, gift, side job" onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></label>
          <label className="field" style={{ flex: '1 1 120px' }}>Take-home amount<input className="input num" inputMode="decimal" placeholder="$" value={draft.amount} onChange={(e) => setDraft({ ...draft, amount: e.target.value })} /></label>
          <label className="field">Month<input className="input" type="month" value={draft.month || shiftMonth(p.startMonth, 3)} onChange={(e) => setDraft({ ...draft, month: e.target.value })} /></label>
          <button className="btn primary" type="submit">+ Add one-time income</button>
        </form>
      </section>
    </div>
  );
}
