import { useEffect, useRef, useState } from 'react';
import { daysInMonth, dayOfWeek, isoDate, parseCents, type ScheduledEvent } from '@hearth/core';
import { api, type CalendarView, type Forecast } from '../api';
import { MonthPicker, PageHead, Tip, todayISO, useLoad, usd } from '../components/ui';

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const fmtDay = (d: string, opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' }) => new Date(d + 'T12:00:00').toLocaleDateString('en-US', opts);
const sourceNote = (e: ScheduledEvent) =>
  e.source === 'moved' ? 'Moved just this month'
    : e.source === 'manual' ? (e.kind === 'pay' ? 'Direct deposit' : 'Date set by you')
    : e.source === 'learned' ? `Learned from Kemba · usually within ${e.windowDays} day${e.windowDays === 1 ? '' : 's'}`
    : 'Estimated date · drag to correct';

type Pending = { e: ScheduledEvent; toDate: string } | null;

export function Calendar({ month, setMonth }: { month: string; setMonth: (m: string) => void }) {
  const { data, reload } = useLoad(() => api.get<CalendarView>(`/api/calendar?month=${month}`), [month]);
  const today = todayISO();
  const [sel, setSel] = useState<string>(today.startsWith(month) ? today : isoDate(month, 1));
  const [pending, setPending] = useState<Pending>(null);
  const [moveFor, setMoveFor] = useState<{ e: ScheduledEvent; date: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // ---- drag a chip to another day ----
  const [drag, setDrag] = useState<{ e: ScheduledEvent; x: number; y: number; moved: boolean } | null>(null);
  const [overDay, setOverDay] = useState<string | null>(null);
  const overRef = useRef(overDay);
  overRef.current = overDay;
  const startDrag = (pe: React.PointerEvent, e: ScheduledEvent) => {
    if (pe.button !== 0) return;
    pe.preventDefault();
    pe.stopPropagation();
    setDrag({ e, x: pe.clientX, y: pe.clientY, moved: false });
  };
  useEffect(() => {
    if (!drag) return;
    const start = { x: drag.x, y: drag.y };
    const ev = drag.e;
    let moved = false;
    document.body.classList.add('dragging');
    const move = (p: PointerEvent) => {
      if (!moved && Math.hypot(p.clientX - start.x, p.clientY - start.y) < 6) return;
      moved = true;
      setDrag((d) => (d ? { ...d, x: p.clientX, y: p.clientY, moved: true } : d));
      const cell = (document.elementFromPoint(p.clientX, p.clientY) as HTMLElement | null)?.closest<HTMLElement>('[data-day]');
      setOverDay(cell?.dataset.day ?? null);
    };
    const up = () => {
      const to = overRef.current;
      setDrag(null);
      setOverDay(null);
      if (!moved) { setSel(ev.date); return; }
      if (to && to !== ev.date) setPending({ e: ev, toDate: to });
    };
    const key = (k: KeyboardEvent) => { if (k.key === 'Escape') { setDrag(null); setOverDay(null); } };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
    addEventListener('keydown', key);
    return () => {
      document.body.classList.remove('dragging');
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      removeEventListener('keydown', key);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag?.e.scheduleId, drag?.e.originalDate]);

  const commitMove = async (e: ScheduledEvent, toDate: string, scope: 'once' | 'ongoing') => {
    setPending(null);
    setMoveFor(null);
    setErr(null);
    try {
      await api.post('/api/calendar/move', { scheduleId: e.scheduleId, originalDate: e.originalDate, toDate, scope });
      setSel(toDate.startsWith(month) ? toDate : sel);
      reload();
    } catch (x) { setErr((x as Error).message); }
  };
  const reset = async (e: ScheduledEvent) => { await api.post('/api/calendar/reset', { scheduleId: e.scheduleId, originalDate: e.originalDate }); reload(); };

  const first = dayOfWeek(isoDate(month, 1));
  const days = daysInMonth(month);
  const byDay = new Map<string, ScheduledEvent[]>();
  for (const e of data?.events ?? []) byDay.set(e.date, [...(byDay.get(e.date) ?? []), e]);
  const selEvents = byDay.get(sel) ?? [];
  const totals = (data?.events ?? []).reduce((a, e) => ({ inn: a.inn + Math.max(0, e.amount), out: a.out + Math.min(0, e.amount) }), { inn: 0, out: 0 });
  const lowDays = new Set((data?.forecast?.points ?? []).filter((p) => p.balance < (data?.forecast?.cushion ?? 0)).map((p) => p.date));

  return (
    <div className="stack screen">
      <PageHead sub="Paydays, bills and savings moves" title="Calendar"><MonthPicker month={month} onChange={(m) => { setMonth(m); setSel(isoDate(m, 1)); }} /></PageHead>

      {data?.forecast?.firstBelow && <ForecastWarning f={data.forecast} />}
      {err && <div className="notice warn">{err}</div>}

      <div className="row-wrap" style={{ alignItems: 'flex-start', gap: 20 }}>
        <div className="card" style={{ flex: '3 1 520px', minWidth: 0 }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 14, fontSize: 12, marginBottom: 12 }} className="muted">
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><span className="dot" style={{ background: 'var(--accent)' }} />Pay {usd(totals.inn)}</span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><span className="dot" style={{ background: 'var(--warn)' }} />Bills {usd(-totals.out)}</span>
            <span>Drag an item to another day to change its date.</span>
            <Tip label="About calendar dates" text="Dashed items are estimated dates. Drag any item to another day, then choose just this month or every month. Once Kemba is connected, Hearth learns real dates from your history but never overrides a date you set." />
          </div>
          <div className="table-scroll"><div style={{ minWidth: 560 }}>
            <div className="cal" style={{ marginBottom: 6 }}>{DOW.map((d) => <span key={d} className="cal-dow">{d}</span>)}</div>
            <div className="cal">
              {Array.from({ length: first }, (_, i) => <span key={`b${i}`} />)}
              {Array.from({ length: days }, (_, i) => {
                const d = isoDate(month, i + 1);
                const ev = byDay.get(d) ?? [];
                const cls = 'cal-cell' + (overDay === d ? ' drop-target' : '') + (lowDays.has(d) ? ' low' : '');
                return (
                  <div key={d} className={cls} data-day={d} role="button" tabIndex={0} aria-pressed={sel === d} aria-label={`${fmtDay(d, { month: 'long', day: 'numeric' })}, ${ev.length} scheduled`}
                    onClick={() => setSel(d)} onKeyDown={(k) => { if (k.key === 'Enter' || k.key === ' ') setSel(d); }}
                    style={d === today ? { borderColor: 'var(--ink)' } : undefined}>
                    <span style={{ fontSize: 12, fontWeight: d === today ? 700 : 500 }}>{i + 1}</span>
                    {ev.slice(0, 3).map((e) => (
                      <span key={e.scheduleId + e.originalDate} className={`cal-chip k-${e.kind} src-${e.source}` + (drag?.e === e && drag.moved ? ' is-dragging' : '')}
                        onPointerDown={(pe) => startDrag(pe, e)} title={`${e.name} · drag to move`}>
                        {e.amount > 0 ? '+' : ''}{usd(Math.abs(e.amount))} {e.name.replace('Payday — ', '')}
                      </span>
                    ))}
                    {ev.length > 3 && <span className="small muted">+{ev.length - 3} more</span>}
                  </div>
                );
              })}
            </div>
          </div></div>
        </div>

        <div className="stack" style={{ flex: '2 1 280px', gap: 20 }}>
          <div className="card">
            <div className="muted" style={{ fontSize: 13 }}>{fmtDay(sel, { weekday: 'long', month: 'long', day: 'numeric' })}</div>
            {selEvents.length === 0 && <div className="list-row muted">Nothing scheduled.</div>}
            {selEvents.map((e) => (
              <div key={e.scheduleId + e.originalDate} className="list-row" style={{ flexWrap: 'wrap' }}>
                <span className="dot" style={{ background: e.kind === 'pay' ? 'var(--accent)' : e.kind === 'save' ? 'var(--blue)' : 'var(--warn)' }} />
                <div style={{ flex: '1 1 140px', minWidth: 0 }}>
                  <div>{e.name}</div>
                  <div className="small muted">{e.variable ? 'Amount varies · ' : ''}{sourceNote(e)}</div>
                </div>
                <strong className={e.amount > 0 ? 'good' : undefined}>{e.amount > 0 ? '+' : ''}{usd(Math.abs(e.amount), true)}</strong>
                <div style={{ display: 'flex', gap: 6, flexBasis: '100%', paddingLeft: 22 }}>
                  <button className="btn sm" onClick={() => setMoveFor({ e, date: e.date })}>Change date</button>
                  {e.source === 'moved' && <button className="btn sm ghost" onClick={() => reset(e)}>Undo move</button>}
                </div>
                {moveFor && moveFor.e === e && (
                  <div className="notice good screen" style={{ flexBasis: '100%' }}>
                    <input type="date" className="input sm" value={moveFor.date} onChange={(x) => setMoveFor({ e, date: x.target.value })} aria-label={`New date for ${e.name}`} />
                    <button className="btn sm" onClick={() => commitMove(e, moveFor.date, 'once')}>Just this month</button>
                    <button className="btn sm accent" onClick={() => commitMove(e, moveFor.date, 'ongoing')}>Every month</button>
                    <button className="btn sm ghost" onClick={() => setMoveFor(null)}>Cancel</button>
                  </div>
                )}
              </div>
            ))}
          </div>
          <ForecastCard f={data?.forecast ?? null} onChange={reload} />
        </div>
      </div>

      {drag?.moved && (
        <div className="drag-ghost" style={{ left: drag.x + 14, top: drag.y + 14 }} aria-hidden="true">
          <strong>{drag.e.name}</strong>
          <span>{overDay ? `To ${fmtDay(overDay, { weekday: 'short', month: 'short', day: 'numeric' })}` : 'Drop on a day'}</span>
        </div>
      )}

      {pending && (
        <div className="modal-backdrop" role="presentation" onClick={() => setPending(null)}>
          <div className="card modal screen" role="dialog" aria-modal="true" aria-labelledby="move-title" onClick={(x) => x.stopPropagation()}>
            <h2 id="move-title">Move {pending.e.name}</h2>
            <div className="muted" style={{ fontSize: 14, margin: '6px 0 16px' }}>
              From {fmtDay(pending.e.date, { weekday: 'short', month: 'short', day: 'numeric' })} to {fmtDay(pending.toDate, { weekday: 'short', month: 'short', day: 'numeric' })}.
            </div>
            <div className="stack" style={{ gap: 10 }}>
              <button className="btn" style={{ height: 'auto', padding: '12px 14px', flexDirection: 'column', alignItems: 'flex-start' }} onClick={() => commitMove(pending.e, pending.toDate, 'once')}>
                <strong>Just this month</strong><span className="small muted">A one-time change, like a late bill. Next month goes back to normal.</span>
              </button>
              <button className="btn" style={{ height: 'auto', padding: '12px 14px', flexDirection: 'column', alignItems: 'flex-start', borderColor: 'var(--accent)' }} onClick={() => commitMove(pending.e, pending.toDate, 'ongoing')}>
                <strong>Every month from now</strong><span className="small muted">The billing date changed. Hearth will expect it on the {ordinal(Number(pending.toDate.slice(8)))} each month.</span>
              </button>
              <button className="btn ghost" onClick={() => setPending(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const ordinal = (n: number) => n + (['th', 'st', 'nd', 'rd'][n % 100 > 10 && n % 100 < 14 ? 0 : n % 10] ?? 'th');

function ForecastWarning({ f }: { f: Forecast }) {
  const b = f.firstBelow!;
  return (
    <div className="notice warn screen" role="alert">
      <strong>Heads up:</strong>
      <span>Checking could drop to {b.balance < 0 ? '−' : ''}{usd(Math.abs(b.balance))} on {fmtDay(b.date, { weekday: 'short', month: 'short', day: 'numeric' })}, below your {usd(f.cushion)} cushion. Moving a bill after the next payday or trimming everyday spending would keep you above it.</span>
    </div>
  );
}

export function ForecastCard({ f, onChange }: { f: Forecast | null; onChange: () => void }) {
  const [bal, setBal] = useState('');
  const [editing, setEditing] = useState(false);
  const [cushion, setCushion] = useState('');
  const saveBal = async () => { if (!bal.trim()) return; await api.put('/api/accounts/checking', { balance: bal }); setBal(''); setEditing(false); onChange(); };
  const saveCushion = async () => { if (!cushion.trim()) return; await api.put('/api/settings/cushion', { amount: cushion }); setCushion(''); onChange(); };

  if (!f || editing) {
    return (
      <div className="card">
        <div className="stat-label" style={{ marginBottom: 8 }}><h2 style={{ color: 'var(--ink)' }}>Will checking stay above water?</h2>
          <Tip label="About the forecast" text="Until Kemba is connected, enter today's Joint Checking balance. Hearth adds scheduled pay, subtracts bills and an everyday allowance, and warns you before the balance would drop below your cushion." /></div>
        <div className="muted" style={{ fontSize: 13, marginBottom: 10 }}>Enter today's Joint Checking balance to see the next 45 days.</div>
        <form style={{ display: 'flex', gap: 8 }} onSubmit={(e) => { e.preventDefault(); saveBal(); }}>
          <input className="input num" inputMode="decimal" placeholder="$ balance" value={bal} onChange={(e) => setBal(e.target.value)} aria-label="Checking balance" style={{ flex: 1 }} />
          <button className="btn primary" type="submit">Save</button>
          {editing && <button className="btn ghost" type="button" onClick={() => setEditing(false)}>Cancel</button>}
        </form>
      </div>
    );
  }

  const max = Math.max(f.cushion, ...f.points.map((p) => p.balance), 1);
  const min = Math.min(0, ...f.points.map((p) => p.balance));
  const range = max - min || 1;
  const h = (v: number) => ((v - min) / range) * 100;
  return (
    <div className="card">
      <div className="stat-label" style={{ marginBottom: 4 }}><h2 style={{ color: 'var(--ink)' }}>Checking forecast</h2>
        <Tip label="About the forecast" text="Projected end-of-day balance for 45 days: scheduled pay and bills plus an everyday allowance. It assumes bills come out at the earliest they usually do and pay arrives at the latest, so it shows the tightest it is likely to get." /></div>
      <div className="small muted" style={{ marginBottom: 12 }}>
        From {usd(f.startBalance, true)} on {fmtDay(f.asOf)} · {usd(f.dailySpend)}/day everyday allowance · <button className="btn sm ghost" style={{ padding: 0, height: 'auto' }} onClick={() => setEditing(true)}>Update balance</button>
      </div>
      <div style={{ position: 'relative', height: 110, display: 'flex', alignItems: 'flex-end', gap: 2 }} aria-label="Projected balance chart" role="img">
        <div style={{ position: 'absolute', left: 0, right: 0, bottom: `${h(f.cushion)}%`, borderTop: '1.5px dashed var(--ink)', zIndex: 1 }} />
        {f.points.map((p) => (
          <div key={p.date} title={`${fmtDay(p.date)}: ${usd(p.balance)}`} style={{ flex: 1, height: `${Math.max(2, h(p.balance))}%`, borderRadius: '2px 2px 0 0', background: p.balance < f.cushion ? 'var(--warn)' : 'var(--chart-partial)' }} />
        ))}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between' }} className="small muted"><span>{fmtDay(f.points[0]!.date)}</span><span>{fmtDay(f.points[f.points.length - 1]!.date)}</span></div>
      <div style={{ fontSize: 13, marginTop: 10 }} className={f.firstBelow ? 'warn' : 'good'}>
        {f.firstBelow
          ? `Dips below your ${usd(f.cushion)} cushion on ${fmtDay(f.firstBelow.date)}.`
          : `Lowest point ${usd(f.lowest!.balance)} on ${fmtDay(f.lowest!.date)}, above your ${usd(f.cushion)} cushion.`}
      </div>
      <form style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12 }} onSubmit={(e) => { e.preventDefault(); saveCushion(); }}>
        <span className="small muted">Cushion</span>
        <input className="input sm num" inputMode="decimal" placeholder={usd(f.cushion)} value={cushion} onChange={(e) => setCushion(e.target.value)} aria-label="Cushion amount" style={{ width: 110 }} />
        <button className="btn sm" type="submit" disabled={!parseCents(cushion) && cushion !== '0'}>Set</button>
      </form>
    </div>
  );
}
