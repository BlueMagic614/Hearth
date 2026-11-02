import { api } from '../api';
import { Tip, todayISO, usd, useLoad } from './ui';

export interface PlanItem { scheduleId: string; categoryId: string | null; name: string; date: string; amount: number; kind: 'bill' | 'save' | 'cash' | 'card'; variable: boolean }
export interface Period { id: string; person: string; payDate: string; amount: number; from: string; to: string; items: PlanItem[]; outflow: number; surplus: number; carryIn: number; short: number }
export interface PaycheckView {
  month: string; periods: Period[]; payers: Record<string, string>;
  unscheduled: { categoryId: string; name: string; amount: number; kind: string | null }[];
  paydays: { person: string; day: number; amount: number }[];
}

const fmt = (d: string, o: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' }) => new Date(d + 'T12:00:00').toLocaleDateString('en-US', o);
const ord = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'}`;

/** The check paying for today, if any, from a plan. */
export function currentPeriod(plan: PaycheckView | null | undefined, today = todayISO()) {
  return plan?.periods.find((p) => today >= p.payDate && today <= p.to) ?? null;
}

/**
 * Money by paycheck: each check covers what's due after it through the next payday (a bill due on a payday is
 * paid by the check before; tithe and savings moves come out of that day's check).
 */
export function PaycheckPlan({ month }: { month: string }) {
  const plan = useLoad(() => api.get<PaycheckView>(`/api/paychecks?month=${month}`), [month]);
  const today = todayISO();
  const p = plan.data;
  if (plan.error) return <div className="notice warn">{plan.error}</div>;
  if (!p) return <div className="muted">Lining up paychecks…</div>;
  const now = currentPeriod(p, today);

  return (
    <div className="stack">
      <div className="notice good">
        <span>Each check pays for everything due after it, up to and including the next payday. A bill due on a payday is paid by the check before, since money can leave before a deposit lands. Tithe and savings moves come out of that day's check. Money a check leaves over carries forward to the next one (counted from the start of last month, as if it went to plan).</span>
      </div>

      <div className="pay-grid">
        {p.periods.map((x) => {
          const pct = x.amount ? Math.min(100, (x.outflow / x.amount) * 100) : 0;
          const live = now?.id === x.id;
          const past = x.to < today;
          return (
            <section key={x.id} className={'card pay-card' + (live ? ' live' : '') + (past ? ' past' : '')} aria-label={`${x.person}'s ${fmt(x.payDate)} check`}>
              <header className="pay-head">
                <div>
                  <div className="pay-who">{x.person}'s check · {fmt(x.payDate, { weekday: 'short', month: 'short', day: 'numeric' })}</div>
                  <div className="small muted">Covers {fmt(x.from)} – {fmt(x.to)}{live ? ' · living on this one now' : ''}</div>
                </div>
                <div className="pay-amt">{usd(x.amount)}</div>
              </header>
              <div className="pay-bar" role="img" aria-label={`${usd(x.outflow)} of ${usd(x.amount)} planned`}>
                <span style={{ width: `${pct}%` }} className={x.surplus < 0 ? 'over' : undefined} />
              </div>
              <div className="pay-sum small">
                <span>{usd(x.outflow)} planned</span>
                {x.surplus >= 0
                  ? <span className="good">Leaves {usd(x.surplus)}{x.carryIn > 0 && <span className="muted"> (+{usd(x.carryIn)} carried in)</span>}</span>
                  : x.short === 0
                    ? <span className="warn-text">{usd(-x.surplus)} more than this check · covered by {usd(x.carryIn)} carried from earlier checks</span>
                    : <span className="warn-text"><b>Short {usd(x.short)}</b>{x.carryIn ? ` even with ${usd(x.carryIn)} carried in` : ''}</span>}
              </div>
              <ul className="pay-items">
                {x.items.map((i, k) => (
                  <li key={k} className={i.date < today && i.kind !== 'cash' && i.kind !== 'card' ? 'done' : undefined}>
                    <span className="muted">{i.kind === 'cash' || i.kind === 'card' ? '' : fmt(i.date)}</span>
                    <span>{i.name}{i.variable && i.kind === 'bill' && <span className="muted small"> · varies</span>}
                      {i.kind === 'save' && <span className="pending-badge cash-badge">saving</span>}</span>
                    <span className="num">{usd(i.amount)}</span>
                  </li>
                ))}
              </ul>
              {x.short > 0 && (
                <div className="notice warn small">
                  Move a bill after {fmt(x.to)}, or set aside {usd(x.short)} from an earlier check, so this one doesn't come up short.
                </div>
              )}
            </section>
          );
        })}
      </div>

      {p.unscheduled.length > 0 && (
        <div className="card">
          <h2 style={{ marginBottom: 4 }}>Not tied to a check yet
            <Tip label="About unscheduled items" text="Monthly money with no date: savings moves and extra debt payments. Choose which check pays for each and it comes out of that check every month (it also shows on the calendar)." />
          </h2>
          {p.unscheduled.map((u) => (
            <div key={u.categoryId} className="list-row">
              <span style={{ flex: 1 }}>{u.name}</span>
              <span style={{ width: 90, textAlign: 'right', fontWeight: 500 }}>{usd(u.amount)}</span>
              <select className="input sm" style={{ width: 'auto' }} value="" aria-label={`Which check pays ${u.name}`}
                onChange={(e) => e.target.value && api.post('/api/paychecks/assign', { categoryId: u.categoryId, payDay: Number(e.target.value) }).then(plan.reload)}>
                <option value="">Pay from…</option>
                {p.paydays.map((d) => <option key={`${d.person}${d.day}`} value={d.day}>{d.person}'s {ord(d.day)} check</option>)}
              </select>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
