import { leaves, type CategoryNode } from '@hearth/core';
import { api, type BudgetView, type CalendarView, type PlanView } from '../api';
import { Bar, PageHead, Remaining, Tip, todayISO, useLoad, usd } from '../components/ui';

const nextMonth = (m: string) => { const [y, mo] = m.split('-').map(Number) as [number, number]; const i = y * 12 + mo; return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`; };

export function Today({ name, month, go }: { name: string; month: string; go: (tab: string) => void }) {
  const budget = useLoad(() => api.get<BudgetView>(`/api/budget?month=${month}`), [month]);
  const cal = useLoad(async () => {
    const [a, b] = await Promise.all([api.get<CalendarView>(`/api/calendar?month=${month}`), api.get<CalendarView>(`/api/calendar?month=${nextMonth(month)}`)]);
    return [...a.events, ...b.events];
  }, [month]);
  const plan = useLoad(() => api.get<PlanView>('/api/plan'), []);
  const today = todayISO();
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

  const upcoming = (cal.data ?? []).filter((e) => e.date > today).slice(0, 7);
  const nextPay = (cal.data ?? []).find((e) => e.date > today && e.kind === 'pay');
  const b = budget.data;
  const everyday = b ? leaves(b.tree).filter((n: CategoryNode) => n.kind === 'everyday').sort((x, y) => y.totalPlanned - x.totalPlanned).slice(0, 5) : [];

  return (
    <div className="stack screen">
      <PageHead sub={new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })} title={`${greeting}, ${name}`} />

      <div className="row-wrap">
        <div className="card grow">
          <div className="stat-label">Spent this month <Tip label="About spent this month" text="Everything entered against a category this month. Kemba transactions will fill this in automatically from Phase 2." /></div>
          <div className="stat-value">{b ? usd(b.spentTotal) : '—'}</div>
          <div className="stat-note">{b ? `of ${usd(b.plannedTotal)} planned` : ''}</div>
        </div>
        <div className="card grow">
          <div className="stat-label">Left to assign <Tip label="About left to assign" text="Take-home pay minus everything planned. Aim for $0 so every dollar has a job." /></div>
          <div className={'stat-value ' + (b && b.leftToAssign === 0 ? 'good' : 'warn')}>{b ? usd(b.leftToAssign, true) : '—'}</div>
          <div className="stat-note">Starter amounts until Kemba history is in</div>
        </div>
        <div className="card grow">
          <div className="stat-label">Student loans gone <Tip label="About the payoff date" text="Month by month with interest, using your strategy, the extra payment and planned one-time income. Change these on Goals." /></div>
          <div className="stat-value" style={{ color: 'var(--accent)' }}>{plan.data?.current.doneLabel ?? '—'}</div>
          <div className="stat-note">{plan.data ? `${plan.data.current.order[0]} first · ${plan.data.current.paidOff[plan.data.current.order[0]!]}` : ''}</div>
        </div>
      </div>

      <div className="row-wrap" style={{ alignItems: 'flex-start', gap: 20 }}>
        <section className="card" style={{ flex: '3 1 420px', minWidth: 0 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
            <h2>Coming up</h2>
            <button className="btn sm ghost" onClick={() => go('calendar')}>Open calendar →</button>
          </div>
          {nextPay && <div className="small muted" style={{ marginBottom: 6 }}>Next payday: {nextPay.name.replace('Payday — ', '')}, {new Date(nextPay.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}</div>}
          {upcoming.map((e, i) => (
            <div key={i} className="list-row">
              <div style={{ width: 44, textAlign: 'center' }}>
                <div className="small muted" style={{ textTransform: 'uppercase' }}>{new Date(e.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short' })}</div>
                <div style={{ fontSize: 17, fontWeight: 600 }}>{Number(e.date.slice(8))}</div>
              </div>
              <span className="dot" style={{ background: e.kind === 'pay' ? 'var(--accent)' : 'var(--warn)' }} />
              <div style={{ flex: 1, minWidth: 0 }}>{e.name}<div className="small muted">{e.variable ? 'Budgeted · actual varies' : e.kind === 'pay' ? 'Direct deposit' : 'Scheduled'}</div></div>
              <strong className={e.amount > 0 ? 'good' : undefined}>{e.amount > 0 ? '+' : ''}{usd(Math.abs(e.amount))}</strong>
            </div>
          ))}
        </section>

        <section className="card" style={{ flex: '2 1 300px', minWidth: 0 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <h2>Budget pulse</h2>
            <button className="btn sm ghost" onClick={() => go('budget')}>All categories →</button>
          </div>
          {everyday.map((n) => (
            <div key={n.id} style={{ padding: '9px 0' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 7 }}><span>{n.name}</span><Remaining planned={n.totalPlanned} spent={n.totalSpent} /></div>
              <Bar spent={n.totalSpent} planned={n.totalPlanned} />
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}
