import { addDays, addMonths, daysInMonth, eventsForMonth, type ISODate, type ScheduledEvent, type YearMonth } from '@hearth/core';
import type { Db } from './db';
import { categoryRows, overridesFor, schedulesFor } from './services';

/**
 * The Paycheck Plan, in halves of the month. Paydays pair up in order of day of the month (Renee's 10th with
 * Jason's 15th, Renee's 25th with Jason's 30th). Each half has two steps:
 *   1. the first check alone pays everything until the second payday (inclusive: a bill due on a payday is paid
 *      by the earlier money, since it can leave before the deposit lands);
 *   2. what's left of it, pooled with the second check, pays everything until the next half begins (inclusive).
 * Money marked as paid on payday (tithe, savings moves) comes out of that day's check. Cash envelopes and estimated
 * card spending are spread over the days covered. What a half leaves over carries into the next.
 */

export interface PlanItem { scheduleId: string; categoryId: string | null; name: string; date: ISODate; amount: number; kind: 'bill' | 'save' | 'cash' | 'card'; variable: boolean }
export interface Check { person: string; payDate: ISODate; amount: number }
export interface Step { from: ISODate; to: ISODate; items: PlanItem[]; outflow: number }
export interface Half {
  id: string;
  from: ISODate;
  to: ISODate;
  first: Check;
  second: Check | null;
  /** Step 1: first check alone, until the second payday. */
  step1: Step & { leaves: number };
  /** Step 2: what's left plus the second check, until the next half. */
  step2: (Step & { pool: number; leaves: number }) | null;
  /** Leftover carried in from the half before (never below zero). */
  carryIn: number;
  income: number;
  outflow: number;
  /** Money left when the next half starts (can be negative). */
  end: number;
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

  // Which paydays start a half: pair the paydays by day of the month, first with second, third with fourth.
  const rawDays = [...new Set(pays.map((e) => Number(e.originalDate.slice(8, 10))))].sort((a, b) => a - b);
  const starts = new Set(rawDays.filter((_, i) => i % 2 === 0));
  const isStart = (e: ScheduledEvent) => starts.has(Number(e.originalDate.slice(8, 10)));
  const person = (e: ScheduledEvent) => e.name.replace(/^Payday — /, '');
  const check = (e: ScheduledEvent): Check => ({ person: person(e), payDate: e.date, amount: e.amount });

  /** Everything paid in (after, through], plus payday money on `payday` (it comes out of that day's check). */
  const collect = async (after: ISODate, through: ISODate, payday: ISODate): Promise<Step> => {
    const items: PlanItem[] = [];
    for (const e of out) {
      const s = schedules.find((x) => x.id === e.scheduleId);
      const onPayday = !!s?.onPayday;
      // Payday money due on the step's last day belongs to the check arriving that day (the next step).
      const inside = onPayday ? e.date >= payday && (e.date < through || (e.date === through && through === payday)) : e.date > after && e.date <= through;
      if (!inside) continue;
      items.push({ scheduleId: e.scheduleId, categoryId: s?.categoryId ?? null, name: e.name, date: e.date, amount: Math.round(await amountOf(e)), kind: e.kind === 'save' ? 'save' : 'bill', variable: e.variable });
    }
    const from = addDays(after, 1);
    let cash = 0, card = 0;
    for (let d = from; d <= through; d = addDays(d, 1)) { const r = perDay.get(ym(d)); if (r) { cash += r.cash; card += r.card; } }
    if (cash > 0) items.push({ scheduleId: 'cash', categoryId: null, name: 'Cash for envelopes', date: from, amount: Math.round(cash / 100) * 100, kind: 'cash', variable: false });
    if (card > 0) items.push({ scheduleId: 'card', categoryId: null, name: 'Everyday card spending (estimate)', date: from, amount: Math.round(card), kind: 'card', variable: true });
    items.sort((a, b) => a.date.localeCompare(b.date) || b.amount - a.amount);
    return { from, to: through, items, outflow: items.reduce((t, x) => t + x.amount, 0) };
  };

  const halves: Half[] = [];
  const startEvents = pays.filter(isStart);
  for (let i = 0; i < startEvents.length - 1; i++) {
    const a = startEvents[i]!;
    const next = startEvents[i + 1]!;
    // Halves touching this month, plus last month's so their leftovers carry in.
    if (next.date < `${addMonths(month, -1)}-01` || a.date > `${month}-${String(daysInMonth(month)).padStart(2, '0')}`) continue;
    const b = pays.find((p) => p.date > a.date && p.date < next.date && !isStart(p)) ?? null;
    const s1 = await collect(a.date, b ? b.date : next.date, a.date);
    const step1 = { ...s1, leaves: a.amount - s1.outflow };
    let step2: Half['step2'] = null;
    if (b) {
      const s2 = await collect(b.date, next.date, b.date);
      step2 = { ...s2, pool: 0, leaves: 0 };
    }
    halves.push({ id: `${a.scheduleId}|${a.date}`, from: addDays(a.date, 1), to: next.date, first: check(a), second: b ? check(b) : null, step1, step2,
      carryIn: 0, income: a.amount + (b?.amount ?? 0), outflow: step1.outflow + (step2?.outflow ?? 0), end: 0 });
  }
  halves.sort((x, y) => x.first.payDate.localeCompare(y.first.payDate));
  // Carry leftovers forward from the start of last month (as if it went to plan), then show this month's halves.
  let carry = 0;
  for (const h of halves) {
    h.carryIn = carry;
    if (h.step2) {
      h.step2.pool = h.step1.leaves + h.carryIn + h.second!.amount;
      h.step2.leaves = h.step2.pool - h.step2.outflow;
      h.end = h.step2.leaves;
    } else h.end = h.step1.leaves + h.carryIn;
    carry = Math.max(0, h.end);
  }
  const shown = halves.filter((h) => h.to >= `${month}-01`);

  // Monthly items with no date yet (savings moves, extra debt payments): they need a check to come from.
  const rows = await rowsFor(month);
  const parents = new Set(rows.map((r) => r.parentId).filter(Boolean));
  const scheduled = new Set(schedules.map((s) => s.categoryId).filter(Boolean));
  const unscheduled = rows
    .filter((r) => !parents.has(r.id) && !r.cash && r.planned > 0 && !scheduled.has(r.id) && r.kind !== 'everyday' && r.kind !== 'misc')
    .map((r) => ({ categoryId: r.id, name: r.name, amount: r.planned, kind: r.kind }));

  return { month, halves: shown, unscheduled };
}

const short = (d: string) => new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

/** Which money pays each category's bill this month: "Renee's Nov 10 check" or "Renee's and Jason's pooled checks (Nov 10 + 13)". */
export function payerByCategory(plan: Awaited<ReturnType<typeof paycheckPlan>>) {
  const out: Record<string, string> = {};
  for (const h of plan.halves) {
    for (const i of h.step1.items) if (i.categoryId && ym(i.date) === plan.month && !out[i.categoryId]) out[i.categoryId] = `${h.first.person}'s ${short(h.first.payDate)} check`;
    for (const i of h.step2?.items ?? []) if (i.categoryId && ym(i.date) === plan.month && !out[i.categoryId]) out[i.categoryId] = `${h.first.person}'s and ${h.second!.person}'s pooled checks (${short(h.first.payDate)} + ${short(h.second!.payDate).replace(/^\w+ /, '')})`;
  }
  return out;
}
