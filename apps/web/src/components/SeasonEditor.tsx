import { useState } from 'react';

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const monthsLabel = (m: number[]) => (m.length === 1 ? new Date(2000, m[0]! - 1, 1).toLocaleString('en-US', { month: 'long' }) : m.map((x) => MONTHS[x - 1]).join(', '));

/**
 * When a category happens: every month, or only in chosen months (a yearly registration due May 29). Seasonal
 * categories stay off the budget the rest of the year and have no monthly amount; you enter it in their month.
 */
export function SeasonEditor({ months, dueDay, onSave }: { months: number[] | null | undefined; dueDay: number | null | undefined; onSave: (months: number[] | null, dueDay: number | null) => void }) {
  const [seasonal, setSeasonal] = useState(!!months?.length);
  const [picked, setPicked] = useState<number[]>(months ?? []);
  const [day, setDay] = useState(dueDay ? String(dueDay) : '');
  const changed = seasonal !== !!months?.length || (seasonal && (picked.join() !== (months ?? []).join() || day !== (dueDay ? String(dueDay) : '')));

  return (
    <div className="season">
      <div className="season-row">
        <span className="small muted">Happens</span>
        <button type="button" className="chip" aria-pressed={!seasonal} onClick={() => setSeasonal(false)}>Every month</button>
        <button type="button" className="chip" aria-pressed={seasonal} onClick={() => setSeasonal(true)}>Only in certain months</button>
      </div>
      {seasonal && (
        <div className="season-row">
          <div className="month-chips" role="group" aria-label="Months">
            {MONTHS.map((m, i) => (
              <button key={m} type="button" className="chip sm" aria-pressed={picked.includes(i + 1)}
                onClick={() => setPicked((p) => (p.includes(i + 1) ? p.filter((x) => x !== i + 1) : [...p, i + 1].sort((a, b) => a - b)))}>{m}</button>
            ))}
          </div>
          <label className="small muted" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>Due on day
            <input className="input sm num" style={{ width: 56 }} inputMode="numeric" value={day} onChange={(e) => setDay(e.target.value.replace(/\D/g, '').slice(0, 2))} aria-label="Due day" />
          </label>
        </div>
      )}
      {changed && (
        <div className="season-row">
          <button type="button" className="btn sm accent" disabled={seasonal && !picked.length}
            onClick={() => onSave(seasonal ? picked : null, seasonal && day ? Math.min(31, Math.max(1, Number(day))) : null)}>Save</button>
          <span className="small muted">{seasonal && picked.length ? `Shows only in ${monthsLabel(picked)}; enter the amount when it comes round.` : 'Planned money carries forward every month.'}</span>
        </div>
      )}
    </div>
  );
}
