import { addDays, addMonths, daysInMonth, eventsForMonth, type ISODate, type Schedule, type ScheduledEvent, type YearMonth } from '@hearth/core';
import type { Db } from './db';
import { categoryRows, overridesFor, schedulesFor } from './services';
import { householdToday } from './time';

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
  /**
   * For the half we're in: the real picture from the Kemba checking balance instead of the plan's assumptions.
   * end = balance − still due + checks still to come in this half.
   */
  actual?: { asOf: string; balance: number; stillDue: number; checksToCome: number; end: number; items: PlanItem[] } | null;
}

const ym = (d: string) => d.slice(0, 7) as YearMonth;

/**
 * opts.without drops schedules and opts.virtual adds pretend ones, so placements can be tried without saving them.
 */
export async function paycheckPlan(db: Db, hid: string, month: YearMonth, opts: { without?: Set<string>; virtual?: Schedule[]; cache?: Map<string, unknown>; today?: ISODate } = {}) {
  const [all, overrides] = await Promise.all([schedulesFor(db, hid), overridesFor(db, hid)]);
  const schedules = [...all.filter((s) => !opts.without?.has(s.id)), ...(opts.virtual ?? [])];
  const months = [addMonths(month, -1), month, addMonths(month, 1), addMonths(month, 2)];
  const events = months.flatMap((m) => eventsForMonth(schedules, m, overrides));
  const pays = events.filter((e) => e.kind === 'pay').sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
  const out = events.filter((e) => e.kind !== 'pay');

  // A bill's budgeted amount usually knows better than its schedule (it's what was planned this month).
  const rowsBy = (opts.cache ?? new Map()) as Map<string, Awaited<ReturnType<typeof categoryRows>>>;
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
  // From the pay schedules themselves (not the dates they produce: February turns the 30th into the 28th).
  const rawDays = [...new Set(schedules.filter((x) => x.kind === 'pay').flatMap((x) => x.days ?? []))].sort((a, b) => a - b);
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
  // The half we're in starts from the real checking balance, not from what last month was supposed to leave.
  const today = opts.today ?? householdToday();
  const acct = (await db.query<{ balance: unknown; updated: Date | null }>(
    "SELECT SUM(balance_cents) AS balance, MAX(updated_at) AS updated FROM accounts WHERE household_id = $1 AND type = 'checking' AND NOT hidden", [hid]))[0];
  const live = acct?.updated ? halves.find((h) => today >= h.first.payDate && today <= h.to) : undefined;
  if (live && !opts.virtual?.length) {
    // Bills already paid this half (a linked payment since it began) aren't still due.
    const paid = new Set((await db.query<{ schedule_id: string }>(
      "SELECT DISTINCT schedule_id FROM transactions WHERE household_id = $1 AND schedule_id IS NOT NULL AND date >= $2 AND date <= $3", [hid, live.first.payDate, today])).map((r) => r.schedule_id));
    const remaining: PlanItem[] = [];
    // Cash already pulled this month doesn't need pulling again: what's still to withdraw caps the cash still due.
    const filledBy = new Map((await db.query<{ month: string; s: unknown }>(
      "SELECT month, SUM(amount_cents) AS s FROM cash_fills WHERE household_id = $1 AND kind = 'fill' GROUP BY month", [hid])).map((r) => [r.month, Number(r.s)]));
    const cashLeftIn = new Map<string, number>();
    for (const m of months) cashLeftIn.set(m, Math.max(0, Math.round((perDay.get(m)?.cash ?? 0) * daysInMonth(m)) - (filledBy.get(m) ?? 0)));
    for (const st of [live.step1, ...(live.step2 ? [live.step2] : [])]) {
      const days = Math.round((Date.parse(st.to) - Date.parse(st.from)) / 86400_000) + 1;
      const left = Math.max(0, Math.round((Date.parse(st.to) - Date.parse(today > st.from ? today : st.from)) / 86400_000) + 1);
      for (const i of st.items) {
        if (i.kind === 'cash' || i.kind === 'card') {
          // Cash and card spending for the days still ahead (cash only as far as it hasn't been pulled yet).
          let part = Math.round((i.amount * Math.min(days, left)) / days / 100) * 100;
          if (i.kind === 'cash') {
            const m = ym(today > st.from ? today : st.from);
            part = Math.min(part, cashLeftIn.get(m) ?? part);
            cashLeftIn.set(m, (cashLeftIn.get(m) ?? 0) - part);
          }
          if (part > 0) remaining.push({ ...i, amount: part, name: i.kind === 'cash' ? `Cash still to pull, ${Math.min(days, left)} days` : `${i.name}, ${Math.min(days, left)} days` });
        } else if (i.date >= today && !paid.has(i.scheduleId)) remaining.push(i);
      }
    }
    const balance = Number(acct!.balance);
    const stillDue = remaining.reduce((t, i) => t + i.amount, 0);
    const checksToCome = live.second && live.second.payDate > today ? live.second.amount : 0;
    live.actual = {
      asOf: new Intl.DateTimeFormat('en-CA', { timeZone: process.env.HEARTH_TZ ?? 'America/New_York' }).format(new Date(acct!.updated as Date)),
      balance, stillDue, checksToCome, end: balance - stillDue + checksToCome, items: remaining.sort((a, b) => a.date.localeCompare(b.date)),
    };
  }

  // Carry leftovers forward: from the real end of the current half when we have it, otherwise as if each half went to plan.
  let carry = 0;
  for (const h of halves) {
    h.carryIn = carry;
    if (h.step2) {
      h.step2.pool = h.step1.leaves + h.carryIn + h.second!.amount;
      h.step2.leaves = h.step2.pool - h.step2.outflow;
      h.end = h.step2.leaves;
    } else h.end = h.step1.leaves + h.carryIn;
    if (h.actual) h.end = h.actual.end;
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

  // Savings moves and extra payments already tied to a check (tithe aside): these can be re-placed too.
  const kinds = new Map(rows.map((r) => [r.id, r.kind ?? null]));
  const assigned = schedules
    .filter((s) => s.onPayday && s.categoryId && kinds.get(s.categoryId) !== 'giving' && s.cadence === 'monthly' && !s.id.startsWith('virtual'))
    .map((s) => ({ scheduleId: s.id, categoryId: s.categoryId!, name: rows.find((r) => r.id === s.categoryId)?.name ?? s.name, amount: rows.find((r) => r.id === s.categoryId)?.planned || -s.amount, kind: kinds.get(s.categoryId!) ?? null, payDay: s.days?.[0] ?? 1 }));

  return { month, halves: shown, unscheduled, assigned };
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

// ---------- Letting Hearth decide which check pays savings and extra debt ----------

export interface Placement { categoryId: string; name: string; amount: number; payDay: number; person: string; reason: string }

const ordinal = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'}`;
const money = (c: number) => `$${Math.ceil(Math.abs(c) / 100).toLocaleString('en-US')}`;

/**
 * Places each savings move and extra debt payment on a payday. Biggest first, each goes where the plan stays
 * healthiest, judged on this month and next without carry-over (so each half stands on its own):
 *   1. the smallest "left at the end of a half" is as large as possible (halves stay balanced);
 *   2. then the first check of each half keeps the most room to reach the second payday;
 *   3. then the later payday, so bills come first and saving happens from what's left.
 */
export async function autoPlace(db: Db, hid: string, month: YearMonth) {
  const base = await paycheckPlan(db, hid, month);
  const items = [...base.unscheduled.map((u) => ({ ...u, scheduleId: null as string | null })), ...base.assigned.map((a) => ({ ...a }))]
    .filter((i) => i.amount > 0).sort((a, b) => b.amount - a.amount);
  const without = new Set(base.assigned.map((a) => a.scheduleId));
  const paydays = (await db.query<{ person: string; days: number[] }>('SELECT person, days FROM income_sources WHERE household_id = $1', [hid]))
    .flatMap((r) => r.days.map((d) => ({ person: r.person, day: d }))).sort((a, b) => a.day - b.day);
  const cache = new Map<string, unknown>();
  const next = addMonths(month, 1);

  const virtual = (i: (typeof items)[number], day: number): Schedule => ({
    id: `virtual-${i.categoryId}`, name: i.name, kind: i.kind === 'savings' ? 'save' : 'bill', amount: -i.amount, cadence: 'monthly', days: [day],
    weekendRule: 'before', categoryId: i.categoryId, onPayday: true, dateSource: 'manual', windowDays: 0,
  });
  const evaluate = async (placed: Schedule[]) => {
    const plans = await Promise.all([month, next].map((m) => paycheckPlan(db, hid, m, { without, virtual: placed, cache })));
    const halves = new Map(plans.flatMap((p) => p.halves).map((h) => [h.id, h]));
    const list = [...halves.values()].filter((h) => h.from >= `${month}-01`);
    const nets = list.map((h) => ({ label: `${ordinal(Number(h.first.payDate.slice(8)))}–${ordinal(Number(h.to.slice(8)))}`, net: h.income - h.outflow, alone: h.step1.leaves, h }));
    return { nets, minNet: Math.min(...nets.map((n) => n.net)), minAlone: Math.min(...nets.map((n) => n.alone)) };
  };

  const before = await evaluate([]);
  const chosen: Schedule[] = [];
  const placements: Placement[] = [];
  for (const item of items) {
    let best: { day: number; person: string; score: [number, number, number]; result: Awaited<ReturnType<typeof evaluate>> } | null = null;
    for (let k = 0; k < paydays.length; k++) {
      const p = paydays[k]!;
      const result = await evaluate([...chosen, virtual(item, p.day)]);
      const score: [number, number, number] = [result.minNet, Math.min(0, result.minAlone), k];
      if (!best || score[0] > best.score[0] || (score[0] === best.score[0] && (score[1] > best.score[1] || (score[1] === best.score[1] && score[2] > best.score[2])))) {
        best = { day: p.day, person: p.person, score, result };
      }
    }
    chosen.push(virtual(item, best!.day));
    const tight = [...best!.result.nets].sort((a, b) => a.net - b.net)[0]!;
    const own = best!.result.nets.find((n) => n.h.step1.items.concat(n.h.step2?.items ?? []).some((x) => x.categoryId === item.categoryId));
    const isSecond = paydays.findIndex((p) => p.day === best!.day) % 2 === 1;
    placements.push({
      categoryId: item.categoryId, name: item.name, amount: item.amount, payDay: best!.day, person: best!.person,
      reason: `${own ? `The ${own.label} half has room (${money(own.net)} left after it)` : 'Keeps both halves balanced'}`
        + `${isSecond ? `, and coming from ${best!.person}'s check keeps ${paydays[paydays.findIndex((p) => p.day === best!.day) - 1]?.person ?? 'the first'}'s check free to cover bills until payday` : ''}.`
        + `${tight.net < 0 ? ` Even so, the ${tight.label} half comes up ${money(tight.net)} short.` : ''}`,
    });
  }
  const after = chosen.length ? await evaluate(chosen) : before;
  const summary = (r: typeof before) => r.nets.map((n) => ({ half: n.label, from: n.h.first.payDate, leftAtEnd: n.net, firstCheckAlone: n.alone }));
  return { placements, before: summary(before), after: summary(after) };
}

/** Ties a monthly item to a payday (savings move, extra debt payment), creating or updating its schedule. */
export async function assignToCheck(db: Db, hid: string, categoryId: string, payDay: number, newId: () => string) {
  const cat = (await db.query<{ id: string; name: string; kind: string | null; planned: number | null }>(
    `SELECT c.id, c.name, c.kind, (SELECT planned_cents FROM budgets b WHERE b.category_id = c.id ORDER BY month DESC LIMIT 1) AS planned
     FROM categories c WHERE c.id = $1 AND c.household_id = $2 AND NOT c.archived`, [categoryId, hid]))[0];
  if (!cat) return 'missing' as const;
  const existing = (await db.query<{ id: string }>('SELECT id FROM schedules WHERE category_id = $1', [cat.id]))[0];
  if (existing) {
    await db.query("UPDATE schedules SET days = $1, cadence = 'monthly', on_payday = TRUE, date_source = 'manual', window_days = 0 WHERE id = $2", [[payDay], existing.id]);
  } else {
    if (!cat.planned) return 'no-amount' as const;
    await db.query(
      `INSERT INTO schedules (id, household_id, name, kind, amount_cents, cadence, days, weekend_rule, category_id, date_source, window_days, on_payday)
       VALUES ($1,$2,$3,$4,$5,'monthly',$6,'before',$7,'manual',0,TRUE)`,
      [newId(), hid, cat.name, cat.kind === 'savings' ? 'save' : 'bill', -cat.planned, [payDay], cat.id]);
  }
  return 'ok' as const;
}
