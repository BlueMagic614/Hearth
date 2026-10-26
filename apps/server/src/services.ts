import {
  addMonths, buildTree, eventsForMonth, leaves, monthLabel, parseYM, simulatePayoff,
  type CategoryRow, type Lump, type Raise, type Schedule, type Strategy, type YearMonth,
} from '@hearth/core';
import type { Db } from './db';

const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));

export async function categoryRows(db: Db, hid: string, month: YearMonth): Promise<CategoryRow[]> {
  const rows = await db.query<{ id: string; name: string; parent_id: string | null; sort_order: number; kind: string | null; planned: unknown; spent: unknown }>(
    `SELECT c.id, c.name, c.parent_id, c.sort_order, c.kind,
       COALESCE((SELECT b.planned_cents FROM budgets b WHERE b.category_id = c.id AND b.month <= $2 ORDER BY b.month DESC LIMIT 1), 0) AS planned,
       COALESCE((SELECT -SUM(t.amount_cents) FROM transactions t WHERE t.category_id = c.id AND to_char(t.date, 'YYYY-MM') = $2), 0) AS spent
     FROM categories c WHERE c.household_id = $1 AND NOT c.archived`,
    [hid, month],
  );
  return rows.map((r) => ({ id: r.id, name: r.name, parentId: r.parent_id, sortOrder: r.sort_order, kind: r.kind, planned: num(r.planned), spent: num(r.spent) }));
}

export async function monthlyIncome(db: Db, hid: string): Promise<number> {
  const rows = await db.query<{ amount_cents: number; days: number[]; cadence: string }>('SELECT amount_cents, days, cadence FROM income_sources WHERE household_id = $1', [hid]);
  return rows.reduce((s, r) => s + r.amount_cents * (r.cadence === 'semimonthly' ? r.days.length : 1), 0);
}

export async function budgetView(db: Db, hid: string, month: YearMonth) {
  const rows = await categoryRows(db, hid, month);
  const tree = buildTree(rows);
  const income = await monthlyIncome(db, hid);
  const plannedTotal = leaves(tree).reduce((s, n) => s + n.planned, 0);
  const spentTotal = leaves(tree).reduce((s, n) => s + n.spent, 0);
  return { month, income, plannedTotal, spentTotal, leftToAssign: income - plannedTotal, tree };
}

/** Sets the planned amount for one month (upsert). */
export async function setPlanned(db: Db, categoryId: string, month: YearMonth, cents: number) {
  await db.query(
    'INSERT INTO budgets (category_id, month, planned_cents) VALUES ($1,$2,$3) ON CONFLICT (category_id, month) DO UPDATE SET planned_cents = EXCLUDED.planned_cents',
    [categoryId, month, cents],
  );
}

export async function schedulesFor(db: Db, hid: string): Promise<Schedule[]> {
  const bills = await db.query<{ id: string; name: string; kind: string; amount_cents: number; cadence: string; days: number[]; weekday: number | null; weekend_rule: string; variable: boolean; category_id: string | null }>(
    'SELECT * FROM schedules WHERE household_id = $1', [hid],
  );
  const pay = await db.query<{ id: string; person: string; amount_cents: number; cadence: string; days: number[]; weekend_rule: string }>('SELECT * FROM income_sources WHERE household_id = $1', [hid]);
  return [
    ...pay.map((p): Schedule => ({ id: p.id, name: `Payday — ${p.person}`, kind: 'pay', amount: p.amount_cents, cadence: p.cadence as Schedule['cadence'], days: p.days, weekendRule: p.weekend_rule as Schedule['weekendRule'] })),
    ...bills.map((b): Schedule => ({
      id: b.id, name: b.name, kind: b.kind as Schedule['kind'], amount: b.amount_cents, cadence: b.cadence as Schedule['cadence'], days: b.days,
      weekday: b.weekday ?? undefined, weekendRule: b.weekend_rule as Schedule['weekendRule'], variable: b.variable, categoryId: b.category_id,
    })),
  ];
}

export async function calendarView(db: Db, hid: string, month: YearMonth) {
  return { month, events: eventsForMonth(await schedulesFor(db, hid), month) };
}

const monthsBetween = (from: YearMonth, to: YearMonth) => {
  const a = parseYM(from), b = parseYM(to);
  return (b.year - a.year) * 12 + (b.month - a.month);
};

interface IncomeEventRow { id: string; name: string; kind: string; month: string; amount_cents: number; destination: string; enabled: boolean; repeats_yearly: boolean; note: string | null; actual_cents: number | null }

/** Loan plan with interest, both strategies compared, and one-time income applied. */
export async function planView(db: Db, hid: string) {
  const loanRows = await db.query<{ id: string; name: string; balance_cents: number; apr: number; min_payment_cents: number }>('SELECT * FROM loans WHERE household_id = $1 ORDER BY balance_cents', [hid]);
  const planRow = (await db.query<{ strategy: string; extra_cents: number; start_month: string }>('SELECT * FROM loan_plans WHERE household_id = $1', [hid]))[0];
  const events = await db.query<IncomeEventRow>('SELECT * FROM income_events WHERE household_id = $1 ORDER BY month, name', [hid]);
  const goals = await db.query<{ id: string; name: string; kind: string; target_cents: number; saved_cents: number; monthly_cents: number; target_month: string | null; horizon: string | null }>(
    'SELECT * FROM goals WHERE household_id = $1 ORDER BY sort_order', [hid]);

  const start = planRow?.start_month ?? '2026-11';
  const extra = planRow?.extra_cents ?? 0;
  const strategy = (planRow?.strategy ?? 'snowball') as Strategy;
  const loans = loanRows.map((l) => ({ id: l.id, name: l.name, balance: l.balance_cents, apr: Number(l.apr), minPayment: l.min_payment_cents }));
  const share = (e: IncomeEventRow, to: 'loans' | 'emergency') => (e.destination === to ? e.amount_cents : e.destination === 'split' ? Math.round(e.amount_cents / 2) : 0);

  const lumps: Lump[] = [];
  const raises: Raise[] = [];
  let efLump = 0;
  for (const e of events.filter((x) => x.enabled)) {
    const m = monthsBetween(start, e.month) + 1;
    if (e.kind === 'raise') {
      if (share(e, 'loans')) raises.push({ fromMonth: Math.max(1, m), amount: share(e, 'loans') });
      continue;
    }
    for (let k = 0; k < (e.repeats_yearly ? 40 : 1); k++) if (m + 12 * k >= 1 && share(e, 'loans')) lumps.push({ month: m + 12 * k, amount: share(e, 'loans') });
    efLump += share(e, 'emergency');
  }

  const label = (m: number) => monthLabel(addMonths(start, m - 1));
  const run = (s: Strategy, withIncome: boolean) => {
    const r = simulatePayoff({ loans, extraMonthly: extra, strategy: s, lumps: withIncome ? lumps : [], raises: withIncome ? raises : [] });
    return {
      strategy: s, months: r.months, doneLabel: label(r.months), totalInterest: r.totalInterest, incomplete: r.incomplete,
      paidOff: Object.fromEntries(Object.entries(r.paidOffMonth).map(([id, m]) => [loans.find((l) => l.id === id)?.name ?? id, label(m)])),
      order: r.order.map((id) => loans.find((l) => l.id === id)?.name ?? id),
    };
  };
  const minimumsOnly = simulatePayoff({ loans, extraMonthly: 0, strategy: 'snowball', rollover: false });

  const goalsOut = goals.map((g) => {
    if (g.kind === 'debt') {
      const p = run(strategy, true);
      return { ...g, etaLabel: p.doneLabel };
    }
    const remain = Math.max(0, g.target_cents - g.saved_cents - (g.name === 'Emergency fund' ? efLump : 0));
    const months = g.monthly_cents > 0 ? Math.ceil(remain / g.monthly_cents) : null;
    return { ...g, etaLabel: months === null ? 'Set a monthly amount' : label(Math.max(months, 0) || 1) };
  });

  return {
    startMonth: start, strategy, extraCents: extra, loans,
    current: run(strategy, true),
    withoutIncome: run(strategy, false),
    snowball: run('snowball', true),
    avalanche: run('avalanche', true),
    minimumsOnly: { doneLabel: label(minimumsOnly.months), totalInterest: minimumsOnly.totalInterest },
    incomeEvents: events,
    goals: goalsOut,
  };
}
