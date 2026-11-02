import { addMonths, payoffOrder, simulatePayoff, type ISODate, type Strategy, type YearMonth } from '@hearth/core';
import type { Db } from './db';
import { newId } from './auth';
import { forecastView } from './services';

/**
 * Cash envelopes, fill-and-forget style: an ATM withdrawal goes into one shared cash pool and is split into
 * envelopes (cash categories). Filling an envelope counts as that category's spending for the month. Cash still
 * left at month end is counted back out of the envelopes into the Leftovers fund.
 */

export interface Envelope { categoryId: string; name: string; planned: number; filled: number }

const ym = (d: string) => d.slice(0, 7) as YearMonth;
const dim = (m: string) => new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).getUTCDate();

/** Cash categories with what's planned this month and what's been put in so far (net of leftovers taken back out). */
export async function envelopes(db: Db, hid: string, month: YearMonth): Promise<Envelope[]> {
  const rows = await db.query<{ id: string; name: string; planned: unknown; filled: unknown }>(
    `SELECT c.id, c.name,
       CASE WHEN c.months IS NULL
         THEN COALESCE((SELECT b.planned_cents FROM budgets b WHERE b.category_id = c.id AND b.month <= $2 ORDER BY b.month DESC LIMIT 1), 0)
         ELSE COALESCE((SELECT b.planned_cents FROM budgets b WHERE b.category_id = c.id AND b.month = $2), 0) END AS planned,
       COALESCE((SELECT SUM(f.amount_cents) FROM cash_fills f WHERE f.category_id = c.id AND f.month = $2), 0) AS filled
     FROM categories c
     WHERE c.household_id = $1 AND c.cash AND NOT c.archived AND NOT EXISTS (SELECT 1 FROM categories k WHERE k.parent_id = c.id AND NOT k.archived)
       AND (c.months IS NULL OR EXTRACT(MONTH FROM to_date($2 || '-01', 'YYYY-MM-DD'))::int = ANY(c.months))
     ORDER BY c.sort_order, c.name`, [hid, month]);
  return rows.map((r) => ({ categoryId: r.id, name: r.name, planned: Number(r.planned), filled: Number(r.filled) }));
}

/**
 * Default split of a withdrawal: whatever each envelope still needs this month, in whole dollars, in proportion
 * when the withdrawal doesn't cover everything. Anything beyond what the envelopes need stays unassigned.
 */
export function splitAmount(amount: number, need: { categoryId: string; need: number }[]): { categoryId: string | null; amount: number }[] {
  const open = need.filter((n) => n.need > 0);
  const total = open.reduce((s, n) => s + n.need, 0);
  if (!total) return [{ categoryId: null, amount }];
  if (amount >= total) {
    const out: { categoryId: string | null; amount: number }[] = open.map((n) => ({ categoryId: n.categoryId, amount: n.need }));
    if (amount > total) out.push({ categoryId: null, amount: amount - total });
    return out;
  }
  // Proportional, rounded down to dollars; leftover dollars go to the envelopes with the biggest remainders.
  const raw = open.map((n) => ({ categoryId: n.categoryId, exact: (amount * n.need) / total }));
  const out = raw.map((r) => ({ categoryId: r.categoryId as string | null, amount: Math.floor(r.exact / 100) * 100 }));
  let rest = amount - out.reduce((s, o) => s + o.amount, 0);
  const order = raw.map((r, i) => ({ i, rem: r.exact - out[i]!.amount })).sort((a, b) => b.rem - a.rem);
  for (const { i } of order) { if (rest < 100) break; out[i]!.amount += 100; rest -= 100; }
  if (rest > 0) out[order[0]!.i]!.amount += rest;
  return out.filter((o) => o.amount > 0);
}

/** Splits any withdrawal that hasn't been split yet. A withdrawal in the last 3 days of a month, once this month's
 * envelopes are full, is for next month. */
export async function splitNewWithdrawals(db: Db, hid: string): Promise<number> {
  const rows = await db.query<{ id: string; date: string; amount_cents: number; budget_month: string | null }>(
    `SELECT t.id, to_char(t.date, 'YYYY-MM-DD') AS date, t.amount_cents, t.budget_month FROM transactions t
     WHERE t.household_id = $1 AND t.flow = 'cash' AND t.amount_cents < 0 AND NOT t.pending
       AND NOT EXISTS (SELECT 1 FROM cash_fills f WHERE f.transaction_id = t.id) ORDER BY t.date`, [hid]);
  for (const t of rows) {
    let month = (t.budget_month ?? ym(t.date)) as YearMonth;
    let env = await envelopes(db, hid, month);
    const needNow = env.reduce((s, e) => s + Math.max(0, e.planned - e.filled), 0);
    if (!t.budget_month && Number(t.date.slice(8, 10)) > dim(month) - 3 && needNow === 0) {
      month = addMonths(month, 1);
      env = await envelopes(db, hid, month);
      await db.query('UPDATE transactions SET budget_month = $1 WHERE id = $2', [month, t.id]);
    }
    await writeSplit(db, hid, t.id, month, splitAmount(-t.amount_cents, env.map((e) => ({ categoryId: e.categoryId, need: e.planned - e.filled }))), null);
  }
  return rows.length;
}

export async function writeSplit(db: Db, hid: string, txnId: string | null, month: string, parts: { categoryId: string | null; amount: number }[], userId: string | null) {
  if (txnId) await db.query("DELETE FROM cash_fills WHERE transaction_id = $1 AND kind = 'fill'", [txnId]);
  for (const p of parts) {
    if (!p.amount) continue;
    await db.query('INSERT INTO cash_fills (id, household_id, transaction_id, category_id, month, amount_cents, kind, created_by) VALUES ($1,$2,$3,$4,$5,$6,\'fill\',$7)',
      [newId(), hid, txnId, p.categoryId, month, p.amount, userId]);
  }
}

// ---------- Leftovers ----------

export async function leftoverBalance(db: Db, hid: string): Promise<number> {
  const r = (await db.query<{ counted: unknown; moved: unknown }>(
    `SELECT COALESCE((SELECT -SUM(amount_cents) FROM cash_fills WHERE household_id = $1 AND kind = 'leftover'), 0) AS counted,
            COALESCE((SELECT SUM(amount_cents) FROM leftover_moves WHERE household_id = $1), 0) AS moved`, [hid]))[0]!;
  return Number(r.counted) - Number(r.moved);
}

export interface Recommendation {
  destination: 'checking' | 'goal' | 'loan';
  targetId: string | null;
  targetName: string;
  reason: string;
}

/**
 * Where leftover cash would do the most good, in Hearth's order:
 *  1. keep it in checking if the balance is forecast to dip below the cushion;
 *  2. a starter emergency fund of $1,000;
 *  3. a dated savings goal that's behind schedule (vacation, Christmas);
 *  4. otherwise the debt plan: the loan the chosen strategy is paying down first.
 * Alternatives are returned too, so the household can pick another.
 */
export async function recommendLeftovers(db: Db, hid: string, amount: number, today: ISODate): Promise<{ best: Recommendation | null; options: (Recommendation & { impact?: string })[] }> {
  if (amount <= 0) return { best: null, options: [] };
  const options: (Recommendation & { impact?: string })[] = [];
  const f = await forecastView(db, hid, today).catch(() => null);
  const dip = f?.firstBelow;
  const checking: Recommendation = {
    destination: 'checking', targetId: null, targetName: 'Checking',
    reason: dip ? `Checking is forecast to dip to ${usd(dip.balance)} on ${day(dip.date)}, under your ${usd(f!.cushion)} cushion. Deposit it to cover that first.` : 'Deposit it back into checking as extra cushion.',
  };

  const goals = await db.query<{ id: string; name: string; kind: string; target_cents: number; saved_cents: number; monthly_cents: number; target_month: string | null }>(
    'SELECT id, name, kind, target_cents, saved_cents, monthly_cents, target_month FROM goals WHERE household_id = $1 ORDER BY sort_order', [hid]);
  const ef = goals.find((g) => /emergency/i.test(g.name));
  const thisMonth = ym(today);
  const behind = goals
    .filter((g) => g.kind === 'save' && g !== ef && g.target_month && g.saved_cents < g.target_cents)
    .map((g) => {
      const months = Math.max(1, (Number(g.target_month!.slice(0, 4)) - Number(thisMonth.slice(0, 4))) * 12 + Number(g.target_month!.slice(5, 7)) - Number(thisMonth.slice(5, 7)));
      const need = Math.ceil((g.target_cents - g.saved_cents) / months);
      return { g, short: need - g.monthly_cents, months };
    })
    .filter((x) => x.short > 0)
    .sort((a, b) => a.months - b.months);

  const loans = await db.query<{ id: string; name: string; balance_cents: number; apr: number; min_payment_cents: number }>('SELECT id, name, balance_cents, apr, min_payment_cents FROM loans WHERE household_id = $1 AND balance_cents > 0', [hid]);
  const plan = (await db.query<{ strategy: string; extra_cents: number }>('SELECT strategy, extra_cents FROM loan_plans WHERE household_id = $1', [hid]))[0];
  let loanOpt: (Recommendation & { impact?: string }) | null = null;
  if (loans.length) {
    const strategy = (plan?.strategy ?? 'snowball') as Strategy;
    const ls = loans.map((l) => ({ id: l.id, name: l.name, balance: l.balance_cents, apr: Number(l.apr), minPayment: l.min_payment_cents }));
    const first = ls.find((l) => l.id === payoffOrder(ls, strategy)[0])!;
    const base = simulatePayoff({ loans: ls, extraMonthly: plan?.extra_cents ?? 0, strategy });
    const withIt = simulatePayoff({ loans: ls, extraMonthly: plan?.extra_cents ?? 0, strategy, lumps: [{ month: 1, amount }] });
    const saved = base.totalInterest - withIt.totalInterest;
    const sooner = (base.paidOffMonth[first.id] ?? 0) - (withIt.paidOffMonth[first.id] ?? 0);
    loanOpt = {
      destination: 'loan', targetId: first.id, targetName: first.name,
      reason: `${first.name} is next in your ${strategy === 'snowball' ? 'snowball (smallest balance first)' : 'highest-rate-first'} plan.`,
      impact: `Saves about ${usd(saved)} in interest${sooner > 0 ? ` and pays ${first.name} off ${sooner} month${sooner === 1 ? '' : 's'} sooner` : ''}.`,
    };
  }

  let best: Recommendation | null = null;
  if (dip) best = checking;
  else if (ef && ef.saved_cents < 100000) best = { destination: 'goal', targetId: ef.id, targetName: ef.name, reason: `Your emergency fund has ${usd(ef.saved_cents)}; a $1,000 starter fund comes first so a surprise doesn't land on a card.` };
  else if (behind[0]) best = { destination: 'goal', targetId: behind[0].g.id, targetName: behind[0].g.name, reason: `${behind[0].g.name} is about ${usd(behind[0].short)} a month behind to reach ${usd(behind[0].g.target_cents)} by ${monthName(behind[0].g.target_month!)}.` };
  else if (loanOpt) best = loanOpt;
  else if (ef && ef.saved_cents < ef.target_cents) best = { destination: 'goal', targetId: ef.id, targetName: ef.name, reason: `Debt-free: keep building the emergency fund toward ${usd(ef.target_cents)}.` };
  else best = checking;

  const add = (o: (Recommendation & { impact?: string }) | null) => { if (o && !options.some((x) => x.destination === o.destination && x.targetId === o.targetId)) options.push(o); };
  add(best);
  add(loanOpt);
  if (ef && ef.saved_cents < ef.target_cents) add({ destination: 'goal', targetId: ef.id, targetName: ef.name, reason: `${usd(ef.saved_cents)} of ${usd(ef.target_cents)} saved.` });
  for (const b of behind) add({ destination: 'goal', targetId: b.g.id, targetName: b.g.name, reason: `About ${usd(b.short)} a month behind schedule.` });
  add(checking);
  return { best, options };
}

/** Records where leftover money went: a goal's savings grow, a loan's balance drops (so the payoff plan updates). */
export async function moveLeftovers(db: Db, hid: string, userId: string, month: string, amount: number, destination: Recommendation['destination'], targetId: string | null) {
  let name = 'Checking';
  if (destination === 'goal') {
    const g = (await db.query<{ name: string }>('UPDATE goals SET saved_cents = saved_cents + $1 WHERE id = $2 AND household_id = $3 RETURNING name', [amount, targetId, hid]))[0];
    if (!g) throw new Error('Goal not found');
    name = g.name;
  } else if (destination === 'loan') {
    const l = (await db.query<{ name: string }>('UPDATE loans SET balance_cents = GREATEST(0, balance_cents - $1) WHERE id = $2 AND household_id = $3 RETURNING name', [amount, targetId, hid]))[0];
    if (!l) throw new Error('Loan not found');
    name = l.name;
  }
  await db.query('INSERT INTO leftover_moves (id, household_id, month, amount_cents, destination, target_id, target_name, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [newId(), hid, month, amount, destination, targetId, name, userId]);
  return name;
}

const usd = (c: number) => `$${Math.ceil(Math.abs(c) / 100).toLocaleString('en-US')}`;
const day = (d: string) => new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const monthName = (m: string) => new Date(m + '-15T12:00:00Z').toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
