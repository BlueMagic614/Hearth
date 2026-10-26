import { useState } from 'react';
import { daysInMonth, dayOfWeek, isoDate } from '@hearth/core';
import { api, type CalendarView } from '../api';
import { MonthPicker, PageHead, Tip, todayISO, useLoad, usd } from '../components/ui';

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function Calendar({ month, setMonth }: { month: string; setMonth: (m: string) => void }) {
  const { data } = useLoad(() => api.get<CalendarView>(`/api/calendar?month=${month}`), [month]);
  const today = todayISO();
  const [sel, setSel] = useState<string>(today.startsWith(month) ? today : isoDate(month, 1));
  const first = dayOfWeek(isoDate(month, 1));
  const days = daysInMonth(month);
  const byDay = new Map<string, NonNullable<typeof data>['events']>();
  for (const e of data?.events ?? []) byDay.set(e.date, [...(byDay.get(e.date) ?? []), e]);
  const selEvents = byDay.get(sel) ?? [];
  const totals = (data?.events ?? []).reduce((a, e) => ({ inn: a.inn + Math.max(0, e.amount), out: a.out + Math.min(0, e.amount) }), { inn: 0, out: 0 });

  return (
    <div className="stack screen">
      <PageHead sub="Paydays, bills and savings moves" title="Calendar"><MonthPicker month={month} onChange={(m) => { setMonth(m); setSel(isoDate(m, 1)); }} /></PageHead>
      <div className="row-wrap" style={{ alignItems: 'flex-start', gap: 20 }}>
        <div className="card" style={{ flex: '3 1 520px', minWidth: 0 }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, fontSize: 12, marginBottom: 12 }} className="muted">
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><span className="dot" style={{ background: 'var(--accent)' }} />Pay {usd(totals.inn)}</span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><span className="dot" style={{ background: 'var(--warn)' }} />Bills {usd(-totals.out)}</span>
            <Tip label="About bill dates" text="Amounts come from your bills. Due dates are placeholders until Kemba history shows the real ones; variable bills like AEP show their budgeted amount." />
          </div>
          <div className="table-scroll"><div style={{ minWidth: 560 }}>
            <div className="cal" style={{ marginBottom: 6 }}>{DOW.map((d) => <span key={d} className="cal-dow">{d}</span>)}</div>
            <div className="cal">
              {Array.from({ length: first }, (_, i) => <span key={`b${i}`} />)}
              {Array.from({ length: days }, (_, i) => {
                const d = isoDate(month, i + 1);
                const ev = byDay.get(d) ?? [];
                return (
                  <button key={d} className="cal-cell" aria-pressed={sel === d} aria-label={`${d}, ${ev.length} scheduled`} onClick={() => setSel(d)}
                    style={d === today ? { borderColor: 'var(--ink)' } : undefined}>
                    <span style={{ fontSize: 12, fontWeight: d === today ? 700 : 500 }}>{i + 1}</span>
                    {ev.slice(0, 2).map((e, k) => <span key={k} className={`cal-chip k-${e.kind}`}>{e.amount > 0 ? '+' : ''}{usd(Math.abs(e.amount))} {e.name.replace('Payday — ', '')}</span>)}
                    {ev.length > 2 && <span className="small muted">+{ev.length - 2} more</span>}
                  </button>
                );
              })}
            </div>
          </div></div>
        </div>
        <div className="card" style={{ flex: '2 1 280px' }}>
          <div className="muted" style={{ fontSize: 13 }}>{new Date(sel + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</div>
          {selEvents.length === 0 && <div className="list-row muted">Nothing scheduled.</div>}
          {selEvents.map((e, k) => (
            <div key={k} className="list-row">
              <span className="dot" style={{ background: e.kind === 'pay' ? 'var(--accent)' : e.kind === 'save' ? 'var(--blue)' : 'var(--warn)' }} />
              <div style={{ flex: 1 }}><div>{e.name}</div><div className="small muted">{e.variable ? 'Budgeted amount · actual varies' : e.kind === 'pay' ? 'Direct deposit' : 'Scheduled'}</div></div>
              <strong className={e.amount > 0 ? 'good' : undefined}>{e.amount > 0 ? '+' : ''}{usd(Math.abs(e.amount), true)}</strong>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
