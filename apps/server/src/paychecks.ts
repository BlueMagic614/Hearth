import { addDays, addMonths, daysInMonth, eventsForMonth, type ISODate, type ScheduledEvent, type YearMonth } from '@hearth/core';
import type { Db } from './db';
import { categoryRows, overridesFor, schedulesFor } from './services';

/**
 * The Paycheck Plan: money planned by paycheck instead of by month. Each check covers everything due after it,
 * up to and including the next payday (a bill due on a payday is paid by the earlier check, since money can
 * leave before the deposit lands). Money marked as paid on payday (tithe, savings moves) comes out of that day's check.
 * Cash envelopes and estimated card spending are spread over the days each check covers.
 */

export interface PlanItem { scheduleId: string; categoryId: string | null; name: string; date: ISODate; amount: number; kind: 'bill' | 'save' | 'cash' | 'card'; variable: boolean }
export interface Period {
  id: string;
  person: string;
  payDate: ISODate;
  amount: number;
  /** First and last day this check covers. */
  from: ISODate;
  to: ISODate;
  items: PlanItem[];
  outflow: number;
  /** This check minus what it covers. */
  surplus: number;
  /** Surplus carried in from earlier checks in the view (never below zero). */
  carryIn: number;
  short: number;
}

const ym = (d: string) => d.slice(0, 7) as YearMonth;

export async function paycheckPlan(db: Db, hid: string, month: YearMonth) {
  const [schedules, overrides] = await Promise.all([schedulesFor(db, hid), overridesFor(db, hid)]);
  const months = [addMonths(month, -1), month, addMonths(month, 1), addMonths(month, 2)];
  const events = months.flatMap((m) => eventsForMonth(schedules, m, overrides));
  const pays = events.filter((e) => e.kind === 'pay').sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
  const out = events.filter((e) => e.kind !== 'pay');

  // A bill's budgeted amount usually knows better than its schedule (it's what was planned this month).
  const rowsBy = new Map<string, Awaited<ReturnType<typeof categoryRows>>>();
  const rowsFor = async (m: YearMonth) => { if (!rowsBy.has(m)) rowsBy.set(m, await categoryRows(db, hid, m, { includeHidden: true })); return rowsBy.get(m)!; };
  const perCategory = new Map<string, number>();
  for (const s of schedules) if (s.categoryId) perCategory.set(s.categoryId, (perCategory.get(s.categoryId) ?? 0) + (s.cadence === 'monthly' ? 1 : (s.days?.length ?? 2)));

  const amountOf = async (e: ScheduledEvent) => {
    const s = schedules.find((x) => x.id === e.scheduleId);
    if (s?.categoryId && perCategory.get(s.categoryId) === 1) {
      const row = (await rowsFor(ym(e.originalDate))).find((r) => r.id === s.categoryId);
      if (row && row.planned > 0) return row.planned;
    }
    return -e.amount;
  };

  // Cash plan and everyday card spending, per day of each month.
  const perDay = new Map<YearMonth, { cash: number; card: number }>();
  for (const m of months) {
    const rows = await rowsFor(m);
    const parents = new Set(rows.map((r) => r.parentId).filter(Boolean));
    const leaves = rows.filter((r) => !parents.has(r.id));
    const mm = Number(m.slice(5, 7));
    const live = leaves.filter((r) => !r.months?.length || r.months.includes(mm));
    perDay.set(m, {
      cash: live.filter((r) => r.cash).reduce((s, r) => s + r.planned, 0) / daysInMonth(m),
      card: live.filter((r) => r.kind === 'everyday' && !r.cash).reduce((s, r) => s + r.planned, 0) / daysInMonth(m),
    });
  }

  const periods: Period[] = [];
  for (let i = 0; i < pays.length - 1; i++) {
    const p = pays[i]!;
    // Two people paid the same day share one window; each gets its own card.
    const next = pays.slice(i + 1).find((x) => x.date > p.date);
    if (!next) break;
    const from = addDays(p.date, 1);
    const to = next.date;
    // Checks whose window touches this month, plus last month's so money they leave over carries in.
    const prev = addMonths(month, -1);
    if (to < `${prev}-01` || from > `${month}-${String(daysInMonth(month)).padStart(2, '0')}`) continue;
    const sameDay = pays.filter((x) => x.date === p.date);
    const share = 1 / sameDay.length;
    const items: PlanItem[] = [];
    for (const e of out) {
      const s = schedules.find((x) => x.id === e.scheduleId);
      const giving = !!s?.onPayday;
      // Payday money comes out of the check landing that day; any other bill on a payday belongs to the earlier check.
      const inWindow = giving ? e.date >= p.date && e.date < to : e.date >= from && e.date <= to;
      if (!inWindow) continue;
      if (giving && e.date === p.date && sameDay.length > 1 && sameDay.indexOf(p) > 0) continue;
      items.push({ scheduleId: e.scheduleId, categoryId: s?.categoryId ?? null, name: e.name, date: e.date, amount: Math.round((await amountOf(e)) * (giving ? 1 : share)), kind: e.kind === 'save' ? 'save' : 'bill', variable: e.variable });
    }
    // Spread cash and card spending across the days covered.
    let cash = 0, card = 0;
    for (let d = from; d <= to; d = addDays(d, 1)) { const r = perDay.get(ym(d)); if (r) { cash += r.cash; card += r.card; } }
    if (cash > 0) items.push({ scheduleId: 'cash', categoryId: null, name: 'Cash for envelopes', date: from, amount: Math.round((cash * share) / 100) * 100, kind: 'cash', variable: false });
    if (card > 0) items.push({ scheduleId: 'card', categoryId: null, name: 'Everyday card spending (estimate)', date: from, amount: Math.round(card * share), kind: 'card', variable: true });
    items.sort((a, b) => a.date.localeCompare(b.date) || b.amount - a.amount);
    const outflow = items.reduce((s, x) => s + x.amount, 0);
    const person = p.name.replace(/^Payday — /, '');
    periods.push({ id: `${p.scheduleId}|${p.date}`, person, payDate: p.date, amount: p.amount, from, to, items, outflow, surplus: p.amount - outflow, carryIn: 0, short: 0 });
  }
  periods.sort((a, b) => a.payDate.localeCompare(b.payDate) || a.person.localeCompare(b.person));
  // Run the carry-over from the start of last month (as if last month went to plan), then show this month's checks.
  let carry = 0;
  for (const p of periods) {
    p.carryIn = carry;
    p.short = Math.max(0, -(p.surplus + carry));
    carry = Math.max(0, carry + p.surplus);
  }
  const shown = periods.filter((p) => p.to >= `${month}-01`);

  // Monthly items with no date yet (savings moves, extra debt payments): they need a check to come from.
  const rows = await rowsFor(month);
  const parents = new Set(rows.map((r) => r.parentId).filter(Boolean));
  const scheduled = new Set(schedules.map((s) => s.categoryId).filter(Boolean));
  const unscheduled = rows
    .filter((r) => !parents.has(r.id) && !r.cash && r.planned > 0 && !scheduled.has(r.id) && r.kind !== 'everyday' && r.kind !== 'misc')
    .map((r) => ({ categoryId: r.id, name: r.name, amount: r.planned, kind: r.kind }));

  return { month, periods: shown, unscheduled };
}

/** Which check is paying (or will pay) each category's bill this month: categoryId → "Jason · Oct 30". */
export function payerByCategory(plan: Awaited<ReturnType<typeof paycheckPlan>>) {
  const out: Record<string, string> = {};
  for (const p of plan.periods) for (const i of p.items) if (i.categoryId && ym(i.date) === plan.month && !out[i.categoryId]) out[i.categoryId] = `${p.person}'s ${new Date(p.payDate + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })} check`;
  return out;
}
