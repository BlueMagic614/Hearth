import type { Cents } from './money';
import { addDays, addMonths, adjustForWeekend, daysInMonth, isoDate, dayOfWeek, type ISODate, type WeekendRule, type YearMonth } from './dates';

/** Where a schedule's date comes from: not yet known, set by a person, or inferred from bank history. */
export type DateSource = 'placeholder' | 'manual' | 'learned';

/** A repeating money event: a payday, a bill or a savings move. Amount is signed: + income, − outflow. */
export interface Schedule {
  id: string;
  name: string;
  kind: 'pay' | 'bill' | 'save';
  amount: Cents;
  /** 'monthly' uses days[0]; 'semimonthly' uses days (e.g. [15, 30]); 'weekly' uses weekday (0 = Sunday). */
  cadence: 'monthly' | 'semimonthly' | 'weekly';
  days?: number[];
  weekday?: number;
  weekendRule?: WeekendRule;
  /** Estimated (variable) amounts, like utilities. */
  variable?: boolean;
  categoryId?: string | null;
  dateSource?: DateSource;
  /** Days either side of the expected date the money usually moves. */
  windowDays?: number;
}

/** A single occurrence moved to another day. */
export interface ScheduleOverride {
  scheduleId: string;
  originalDate: ISODate;
  newDate: ISODate;
}

export interface ScheduledEvent {
  scheduleId: string;
  /** The day the schedule itself produces, before weekend rules and one-off moves. Identifies the occurrence. */
  originalDate: ISODate;
  date: ISODate;
  name: string;
  kind: Schedule['kind'];
  amount: Cents;
  variable: boolean;
  source: DateSource | 'moved';
  windowDays: number;
}

function rawEvents(schedules: Schedule[], month: YearMonth): ScheduledEvent[] {
  const last = daysInMonth(month);
  const out: ScheduledEvent[] = [];
  for (const s of schedules) {
    let dates: ISODate[] = [];
    if (s.cadence === 'weekly' && s.weekday !== undefined) {
      for (let d = 1; d <= last; d++) {
        const iso = isoDate(month, d);
        if (dayOfWeek(iso) === s.weekday) dates.push(iso);
      }
    } else {
      const days = s.cadence === 'monthly' ? (s.days ?? [1]).slice(0, 1) : (s.days ?? []);
      dates = days.map((d) => isoDate(month, Math.min(d, last)));
    }
    for (const d of dates) {
      out.push({
        scheduleId: s.id,
        originalDate: d,
        date: adjustForWeekend(d, s.weekendRule ?? 'none'),
        name: s.name,
        kind: s.kind,
        amount: s.amount,
        variable: !!s.variable,
        source: s.dateSource ?? 'placeholder',
        windowDays: s.windowDays ?? 0,
      });
    }
  }
  return out;
}

/**
 * Expands schedules into dated events for one month. Days past month end clamp to the last day (30th → Feb 28).
 * One-off overrides move an occurrence to any date, including into a neighbouring month, so the months on either
 * side are expanded too and the result is filtered to the requested month.
 */
export function eventsForMonth(schedules: Schedule[], month: YearMonth, overrides: ScheduleOverride[] = []): ScheduledEvent[] {
  const byKey = new Map(overrides.map((o) => [`${o.scheduleId}|${o.originalDate}`, o.newDate]));
  const all = [addMonths(month, -1), month, addMonths(month, 1)].flatMap((m) => rawEvents(schedules, m));
  return all
    .map((e) => {
      const moved = byKey.get(`${e.scheduleId}|${e.originalDate}`);
      return moved ? { ...e, date: moved, source: 'moved' as const, windowDays: 0 } : e;
    })
    .filter((e) => e.date.startsWith(month))
    .sort((a, b) => a.date.localeCompare(b.date) || b.amount - a.amount);
}

export interface BalancePoint {
  date: ISODate;
  balance: Cents;
}

/**
 * Projects end-of-day checking balance from `start` (exclusive) for `days` days:
 * starting balance + scheduled events − an everyday-spending allowance per day.
 *
 * With `cautious`, money out is assumed to leave at the earliest day of its window and money in to
 * arrive at the latest, so the projection shows the tightest the balance is likely to get.
 */
export function projectBalance(
  startBalance: Cents, start: ISODate, days: number, events: ScheduledEvent[], dailySpend: Cents, opts: { cautious?: boolean } = {},
): BalancePoint[] {
  const byDate = new Map<ISODate, Cents>();
  for (const e of events) {
    const shift = opts.cautious ? (e.amount < 0 ? -e.windowDays : e.windowDays) : 0;
    const d = shift ? addDays(e.date, shift) : e.date;
    byDate.set(d, (byDate.get(d) ?? 0) + e.amount);
  }
  const out: BalancePoint[] = [];
  let bal = startBalance;
  // The starting balance already reflects anything dated on or before `start`.
  for (let i = 1; i <= days; i++) {
    const d = addDays(start, i);
    bal += (byDate.get(d) ?? 0) - dailySpend;
    out.push({ date: d, balance: bal });
  }
  return out;
}

export interface LowBalance {
  /** First day the balance falls below the cushion, or null when it never does. */
  firstBelow: BalancePoint | null;
  lowest: BalancePoint | null;
}

export function lowBalance(points: BalancePoint[], cushion: Cents): LowBalance {
  let lowest: BalancePoint | null = null;
  let firstBelow: BalancePoint | null = null;
  for (const p of points) {
    if (!lowest || p.balance < lowest.balance) lowest = p;
    if (!firstBelow && p.balance < cushion) firstBelow = p;
  }
  return { firstBelow, lowest };
}
