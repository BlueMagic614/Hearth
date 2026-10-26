/** Calendar helpers. Dates are ISO strings (YYYY-MM-DD) and months are YYYY-MM, always in local household time. */
export type ISODate = string;
export type YearMonth = string;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function parseYM(ym: YearMonth): { year: number; month: number } {
  const [y, m] = ym.split('-').map(Number);
  if (!y || !m || m < 1 || m > 12) throw new Error(`Invalid month: ${ym}`);
  return { year: y, month: m };
}

export function ym(year: number, month: number): YearMonth {
  return `${year}-${String(month).padStart(2, '0')}`;
}

/** Adds n months to a YearMonth (n may be negative). */
export function addMonths(base: YearMonth, n: number): YearMonth {
  const { year, month } = parseYM(base);
  const idx = year * 12 + (month - 1) + n;
  return ym(Math.floor(idx / 12), (idx % 12) + 1);
}

/** "Nov 2030" */
export function monthLabel(m: YearMonth): string {
  const { year, month } = parseYM(m);
  return `${MONTHS[month - 1]} ${year}`;
}

export function daysInMonth(m: YearMonth): number {
  const { year, month } = parseYM(m);
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function isoDate(m: YearMonth, day: number): ISODate {
  return `${m}-${String(day).padStart(2, '0')}`;
}

/** Day of week, 0 = Sunday, computed in UTC so it never shifts with the machine's time zone. */
export function dayOfWeek(d: ISODate): number {
  const [y, m, day] = d.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, day!)).getUTCDay();
}

export function addDays(d: ISODate, n: number): ISODate {
  const [y, m, day] = d.split('-').map(Number);
  const t = new Date(Date.UTC(y!, m! - 1, day! + n));
  return t.toISOString().slice(0, 10);
}

export type WeekendRule = 'before' | 'after' | 'none';

/** Moves a date off a weekend: 'before' → previous Friday, 'after' → next Monday. Holidays are not yet considered. */
export function adjustForWeekend(d: ISODate, rule: WeekendRule): ISODate {
  if (rule === 'none') return d;
  const dow = dayOfWeek(d);
  if (dow === 6) return addDays(d, rule === 'before' ? -1 : 2);
  if (dow === 0) return addDays(d, rule === 'before' ? -2 : 1);
  return d;
}
