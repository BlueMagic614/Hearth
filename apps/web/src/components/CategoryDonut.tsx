import { useState } from 'react';
import { usd } from './ui';

export interface Slice { id: string; name: string; planned: number; spent: number }
type Status = 'paid' | 'part' | 'none';

const status = (s: Slice): Status => (s.planned > 0 && s.spent >= s.planned ? 'paid' : s.spent > 0 ? 'part' : 'none');
const label: Record<Status, string> = { paid: 'Paid', part: 'Part paid', none: 'Not yet' };
const MAX = 8;

const polar = (cx: number, cy: number, r: number, a: number) => [cx + r * Math.sin(a), cy - r * Math.cos(a)] as const;
/** A ring segment from angle a0 to a1 (radians, clockwise from 12 o'clock). */
function arc(cx: number, cy: number, r0: number, r1: number, a0: number, a1: number) {
  if (a1 - a0 >= Math.PI * 2 - 1e-6) a1 = a0 + Math.PI * 2 - 1e-4;
  const large = a1 - a0 > Math.PI ? 1 : 0;
  const [x0, y0] = polar(cx, cy, r1, a0);
  const [x1, y1] = polar(cx, cy, r1, a1);
  const [x2, y2] = polar(cx, cy, r0, a1);
  const [x3, y3] = polar(cx, cy, r0, a0);
  return `M${x0} ${y0}A${r1} ${r1} 0 ${large} 1 ${x1} ${y1}L${x2} ${y2}A${r0} ${r0} 0 ${large} 0 ${x3} ${y3}Z`;
}

/**
 * How a parent's planned money splits across its categories. Each slice's size is its planned share;
 * the solid part of a slice is what's been paid this month, the pale part what's still to come.
 */
export function CategoryDonut({ slices, total }: { slices: Slice[]; total: { planned: number; spent: number } }) {
  const [hover, setHover] = useState<number | null>(null);
  const planned = slices.filter((s) => s.planned > 0);
  // Eight colours at most, in a fixed order; anything beyond folds into one neutral slice.
  const shown: (Slice & { color: string })[] = planned.slice(0, MAX).map((s, i) => ({ ...s, color: `var(--cat-${i + 1})` }));
  if (planned.length === MAX + 1) {
    // One extra still gets a neutral slice, but keeps its own name.
    const x = planned[MAX]!;
    shown.push({ ...x, color: 'var(--cat-rest)' });
  } else if (planned.length > MAX) {
    const rest = planned.slice(MAX);
    shown.push({ id: 'rest', name: `${rest.length} more`, planned: rest.reduce((a, s) => a + s.planned, 0), spent: rest.reduce((a, s) => a + s.spent, 0), color: 'var(--cat-rest)' });
  }
  const sum = shown.reduce((a, s) => a + s.planned, 0) || 1;
  const size = 200, c = size / 2, r1 = 92, r0 = 58, gap = shown.length > 1 ? 0.012 : 0;
  let a = 0;
  const geo = shown.map((s) => {
    const span = (s.planned / sum) * Math.PI * 2;
    const g = { a0: a + gap, a1: a + span - gap, paid: Math.min(1, s.spent / s.planned) };
    a += span;
    return g;
  });
  const h = hover === null ? null : shown[hover]!;
  const unplanned = slices.filter((s) => s.planned <= 0);

  return (
    <div className="donut-wrap">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img"
        aria-label={`Planned ${usd(total.planned)}, paid ${usd(total.spent)}. ` + shown.map((s) => `${s.name} ${usd(s.planned)}, ${label[status(s)].toLowerCase()}`).join('; ')}>
        {shown.map((s, i) => {
          const g = geo[i]!;
          const dim = hover !== null && hover !== i;
          return (
            <g key={s.id} onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(null)} style={{ opacity: dim ? 0.45 : 1, transition: 'opacity .15s' }}>
              <path d={arc(c, c, r0, r1, g.a0, g.a1)} fill={s.color} fillOpacity={0.22} />
              {g.paid > 0 && <path d={arc(c, c, r0, r1, g.a0, g.a0 + (g.a1 - g.a0) * g.paid)} fill={s.color} />}
              {/* Wider invisible target so thin slices are easy to hover. */}
              <path d={arc(c, c, r0 - 8, r1 + 6, g.a0 - gap, g.a1 + gap)} fill="transparent" />
            </g>
          );
        })}
        <text x={c} y={c - 6} textAnchor="middle" className="donut-big">{usd(h ? h.planned : total.planned)}</text>
        <text x={c} y={c + 14} textAnchor="middle" className="donut-small">{h ? h.name : 'planned'}</text>
        <text x={c} y={c + 31} textAnchor="middle" className="donut-small">{h ? `${label[status(h)]} · ${usd(h.spent)}` : `${usd(total.spent)} paid`}</text>
      </svg>
      <ul className="donut-legend">
        {shown.map((s, i) => {
          const st = status(s);
          return (
            <li key={s.id} onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(null)} className={hover === i ? 'on' : undefined}>
              <span className="swatch" style={{ background: s.color }} aria-hidden="true" />
              <span className="lg-name">{s.name}</span>
              <span className="lg-num">{usd(s.planned)}</span>
              <span className={`lg-status st-${st}`}>
                <StatusIcon st={st} /> {st === 'part' ? `${usd(s.spent)} of ${usd(s.planned)}` : label[st]}
              </span>
            </li>
          );
        })}
        {unplanned.map((s) => (
          <li key={s.id} className="muted">
            <span className="swatch" style={{ background: 'var(--line)' }} aria-hidden="true" />
            <span className="lg-name">{s.name}</span><span className="lg-num">$0</span><span className="lg-status">{s.spent > 0 ? `${usd(s.spent)} spent, not planned` : 'Not planned'}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Filled = paid, half = part paid, empty ring = not yet. Drawn, so it renders the same everywhere. */
function StatusIcon({ st }: { st: Status }) {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true" style={{ verticalAlign: '-1px' }}>
      <circle cx="6" cy="6" r="5" fill={st === 'paid' ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.5" />
      {st === 'part' && <path d="M6 1a5 5 0 0 1 0 10z" fill="currentColor" />}
      {st === 'paid' && <path d="M3.6 6.2l1.6 1.6 3.2-3.3" fill="none" stroke="var(--surface)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />}
    </svg>
  );
}
