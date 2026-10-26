import type { Cents } from './money';
import { adjustForWeekend, daysInMonth, isoDate, addDays, dayOfWeek, type ISODate, type WeekendRule, type YearMonth } from './dates';

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
}

export interface ScheduledEvent {
  scheduleId: string;
  date: ISODate;
  name: string;
  kind: Schedule['kind'];
  amount: Cents;
  variable: boolean;
}

/** Expands schedules into dated events for one month. Days past month end clamp to the last day (30th → Feb 28). */
export function eventsForMonth(schedules: Schedule[], month: YearMonth): ScheduledEvent[] {
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
        date: adjustForWeekend(d, s.weekendRule ?? 'none'),
        name: s.name,
        kind: s.kind,
        amount: s.amount,
        variable: !!s.variable,
      });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || b.amount - a.amount);
}

export interface BalancePoint {
  date: ISODate;
  balance: Cents;
}

/**
 * Projects end-of-day checking balance from `start` (exclusive) for `days` days:
 * starting balance + scheduled events − an everyday-spending allowance per day.
 */
export function projectBalance(startBalance: Cents, start: ISODate, days: number, events: ScheduledEvent[], dailySpend: Cents): BalancePoint[] {
  const byDate = new Map<ISODate, Cents>();
  for (const e of events) byDate.set(e.date, (byDate.get(e.date) ?? 0) + e.amount);
  const out: BalancePoint[] = [];
  let bal = startBalance;
  for (let i = 1; i <= days; i++) {
    const d = addDays(start, i);
    bal += (byDate.get(d) ?? 0) - dailySpend;
    out.push({ date: d, balance: bal });
  }
  return out;
}
