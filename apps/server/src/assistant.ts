import { addMonths, simulatePayoff, type CategoryNode, type Strategy, type YearMonth } from '@hearth/core';
import type { Db } from './db';
import { envelopes, leftoverBalance, recommendLeftovers } from './cash';
import { paycheckPlan } from './paychecks';
import { budgetView, forecastView, planView, schedulesFor } from './services';
import { householdToday } from './time';

/**
 * "Ask Hearth": a chat assistant that answers from the household's own data. Claude gets read-only tools and
 * calls only the ones a question needs; nothing here changes data. Money in tool results is in dollars.
 */

const d = (c: number) => Math.round(c) / 100;
const MONTH = { type: 'string', description: 'Month as YYYY-MM' } as const;

export const TOOLS = [
  { name: 'get_budget', description: "The month's budget: every category with planned, spent and remaining, whether it's paid with cash envelopes, and whether a fluctuating bill is paid. Totals and take-home pay too.", input_schema: { type: 'object', properties: { month: MONTH }, required: ['month'] } },
  { name: 'get_transactions', description: 'Transactions counted in a month (bank and hand-entered), newest first. Optional filters: a category name (matches parents too) or a payee search.', input_schema: { type: 'object', properties: { month: MONTH, category: { type: 'string' }, search: { type: 'string' }, limit: { type: 'integer' } }, required: ['month'] } },
  { name: 'spending_by', description: 'Spending totals over a range of months, grouped by category or by payee. Good for trends and "where does our money go".', input_schema: { type: 'object', properties: { from: MONTH, to: MONTH, group: { type: 'string', enum: ['category', 'payee'] }, category: { type: 'string' } }, required: ['from', 'to', 'group'] } },
  { name: 'get_paycheck_plan', description: "Which paycheck pays for what in a month: each check's amount, the days it covers, its bills, cash share, leftover, carry-over and any shortfall. Bills due on a payday are paid by the earlier check.", input_schema: { type: 'object', properties: { month: MONTH }, required: ['month'] } },
  { name: 'get_forecast', description: 'Projected checking balance for the next 45 days from the latest Kemba balance, with the lowest point and any day it dips below the cushion.', input_schema: { type: 'object', properties: {} } },
  { name: 'get_bills', description: 'All scheduled bills, paydays and savings moves: due day(s), amount, whether the amount varies, months (for yearly bills) and how the date is known.', input_schema: { type: 'object', properties: {} } },
  { name: 'get_cash', description: "Cash envelopes for a month (planned vs filled, still to pull) and the Leftovers fund with Hearth's recommendation.", input_schema: { type: 'object', properties: { month: MONTH }, required: ['month'] } },
  { name: 'get_debt_and_goals', description: 'Student loans (balance, APR, minimum), the payoff plan (strategy, extra per month, debt-free date, interest, one-time income like the February bonus) and savings goals with progress and ETA.', input_schema: { type: 'object', properties: {} } },
  { name: 'simulate_payoff', description: 'What-if for the student loans: change the extra monthly payment, strategy, or add one-time payments (e.g. a bonus in a given month). Returns debt-free date, total interest and each loan\'s payoff month.', input_schema: { type: 'object', properties: { extra_monthly: { type: 'number', description: 'Dollars per month on top of minimums' }, strategy: { type: 'string', enum: ['snowball', 'avalanche'] }, lumps: { type: 'array', items: { type: 'object', properties: { month: MONTH, amount: { type: 'number' } }, required: ['month', 'amount'] } } } } },
];

const flat = (nodes: CategoryNode[], path = ''): { path: string; node: CategoryNode }[] =>
  nodes.flatMap((n) => [{ path: path + n.name, node: n }, ...flat(n.children, path + n.name + ' › ')]);

export async function runTool(db: Db, hid: string, name: string, input: Record<string, unknown>): Promise<unknown> {
  const month = (typeof input.month === 'string' ? input.month : householdToday().slice(0, 7)) as YearMonth;
  switch (name) {
    case 'get_budget': {
      const v = await budgetView(db, hid, month);
      return {
        month, take_home: d(v.income), planned: d(v.plannedTotal), spent: d(v.spentTotal), left_to_assign: d(v.leftToAssign),
        categories: flat(v.tree).map(({ path, node: n }) => ({
          category: path, parent: n.children.length > 0, planned: d(n.totalPlanned), spent: d(n.totalSpent), remaining: d(n.totalPlanned - n.totalSpent),
          ...(n.cash ? { cash_envelope: true } : {}), ...(n.billPaid ? { fluctuating_bill_paid: true } : {}), ...(n.months?.length ? { only_in_months: n.months } : {}),
        })),
        hidden_this_month: v.hidden?.map((h) => h.name),
      };
    }
    case 'get_transactions': {
      const rows = await db.query<{ date: string; merchant: string; amount_cents: number; category: string | null; parent: string | null; flow: string; pending: boolean; tag: string | null; note: string | null }>(
        `SELECT to_char(t.date, 'YYYY-MM-DD') AS date, t.merchant, t.amount_cents, c.name AS category, p.name AS parent, t.flow, t.pending, t.tag, t.note
         FROM transactions t LEFT JOIN categories c ON c.id = t.category_id LEFT JOIN categories p ON p.id = c.parent_id
         WHERE t.household_id = $1 AND COALESCE(t.budget_month, to_char(t.date, 'YYYY-MM')) = $2
           AND ($3::text IS NULL OR lower(c.name) = lower($3) OR lower(p.name) = lower($3))
           AND ($4::text IS NULL OR t.merchant ILIKE '%' || $4 || '%')
         ORDER BY t.date DESC LIMIT $5`,
        [hid, month, (input.category as string) || null, (input.search as string) || null, Math.min(200, Number(input.limit) || 80)]);
      return rows.map((r) => ({ date: r.date, payee: r.merchant, amount: d(r.amount_cents), category: r.category ? (r.parent ? `${r.parent} › ${r.category}` : r.category) : null,
        ...(r.flow !== 'spend' ? { type: r.flow } : {}), ...(r.pending ? { pending: true } : {}), ...(r.tag ? { tag: r.tag } : {}), ...(r.note ? { note: r.note } : {}) }));
    }
    case 'spending_by': {
      const from = String(input.from), to = String(input.to);
      const byPayee = input.group === 'payee';
      const rows = await db.query<{ key: string; total: unknown; n: unknown }>(
        `SELECT ${byPayee ? 't.merchant' : "COALESCE(c.name, 'Uncategorized')"} AS key, -SUM(t.amount_cents) AS total, COUNT(*) AS n
         FROM transactions t LEFT JOIN categories c ON c.id = t.category_id LEFT JOIN categories p ON p.id = c.parent_id
         WHERE t.household_id = $1 AND t.flow = 'spend' AND COALESCE(t.budget_month, to_char(t.date, 'YYYY-MM')) BETWEEN $2 AND $3
           AND ($4::text IS NULL OR lower(c.name) = lower($4) OR lower(p.name) = lower($4))
         GROUP BY 1 ORDER BY 2 DESC LIMIT 40`, [hid, from, to, (input.category as string) || null]);
      const cash = byPayee ? [] : await db.query<{ key: string; total: unknown }>(
        `SELECT c.name AS key, SUM(f.amount_cents) AS total FROM cash_fills f JOIN categories c ON c.id = f.category_id
         WHERE f.household_id = $1 AND f.month BETWEEN $2 AND $3 GROUP BY 1`, [hid, from, to]);
      return { from, to, note: byPayee ? 'Card and bank spending only (cash envelope spending has no payee).' : 'Includes cash envelope fills (fill-and-forget counts as spending).',
        rows: rows.map((r) => ({ [byPayee ? 'payee' : 'category']: r.key, spent: d(Number(r.total)) + d(Number(cash.find((c) => c.key === r.key)?.total ?? 0)), transactions: Number(r.n) })),
        cash_only: cash.filter((c) => !rows.some((r) => r.key === c.key)).map((c) => ({ category: c.key, spent: d(Number(c.total)) })) };
    }
    case 'get_paycheck_plan': {
      const p = await paycheckPlan(db, hid, month);
      return {
        month, rule: 'A check covers everything due after it through the next payday; bills due on a payday go on the earlier check; tithe and savings moves come out of that day\'s check.',
        checks: p.periods.map((x) => ({ person: x.person, pay_date: x.payDate, amount: d(x.amount), covers: `${x.from} to ${x.to}`, planned_out: d(x.outflow), leaves: d(x.surplus), carried_in: d(x.carryIn), short: d(x.short),
          items: x.items.map((i) => ({ date: i.kind === 'cash' || i.kind === 'card' ? undefined : i.date, name: i.name, amount: d(i.amount), ...(i.variable ? { varies: true } : {}) })) })),
        not_tied_to_a_check: p.unscheduled.map((u) => ({ name: u.name, amount: d(u.amount) })),
      };
    }
    case 'get_forecast': {
      const f = await forecastView(db, hid, householdToday());
      if (!f) return { note: 'No checking balance yet.' };
      return { as_of: f.asOf, start_balance: d(f.startBalance), cushion: d(f.cushion), lowest: f.lowest && { date: f.lowest.date, balance: d(f.lowest.balance) }, first_below_cushion: f.firstBelow && { date: f.firstBelow.date, balance: d(f.firstBelow.balance) },
        weekly: f.points.filter((_, i) => i % 7 === 0).map((p) => ({ date: p.date, balance: d(p.balance) })), note: 'Cautious: bills at the earliest they usually come out, pay at the latest; cash planned as withdrawals.' };
    }
    case 'get_bills': {
      return (await schedulesFor(db, hid)).map((s) => ({ name: s.name, kind: s.kind, amount: d(Math.abs(s.amount)), days: s.cadence === 'weekly' ? `weekly, weekday ${s.weekday}` : s.days,
        ...(s.variable ? { varies: true } : {}), ...(s.months?.length ? { only_in_months: s.months } : {}), date_known_from: s.dateSource, ...(s.windowDays ? { usually_within_days: s.windowDays } : {}) }));
    }
    case 'get_cash': {
      const env = await envelopes(db, hid, month);
      const bal = await leftoverBalance(db, hid);
      const rec = await recommendLeftovers(db, hid, bal, householdToday());
      return { month, envelopes: env.map((e) => ({ category: e.name, planned: d(e.planned), filled: d(e.filled) })), still_to_pull: d(env.reduce((s, e) => s + Math.max(0, e.planned - e.filled), 0)),
        leftovers_fund: d(bal), recommendation: rec.best && { to: rec.best.targetName, why: rec.best.reason } };
    }
    case 'get_debt_and_goals': {
      const p = await planView(db, hid);
      return {
        loans: p.loans.map((l) => ({ name: l.name, balance: d(l.balance), apr_percent: +(l.apr * 100).toFixed(3), minimum: d(l.minPayment) })),
        plan: { strategy: p.strategy, extra_per_month: d(p.extraCents), start: p.startMonth, debt_free: p.current.doneLabel, total_interest: d(p.current.totalInterest), payoff_order: p.current.order, paid_off: p.current.paidOff,
          without_one_time_income: p.withoutIncome.doneLabel, minimums_only: p.minimumsOnly.doneLabel },
        one_time_income: p.incomeEvents.filter((e) => e.enabled).map((e) => ({ name: e.name, kind: e.kind, month: e.month, amount: d(e.amount_cents), goes_to: e.destination, yearly: e.repeats_yearly })),
        goals: p.goals.map((g) => ({ name: g.name, target: d(g.target_cents), saved: d(g.saved_cents), monthly: d(g.monthly_cents), target_month: g.target_month, eta: g.etaLabel })),
      };
    }
    case 'simulate_payoff': {
      const p = await planView(db, hid);
      const strategy = (input.strategy as Strategy) ?? p.strategy;
      const extra = input.extra_monthly !== undefined ? Math.round(Number(input.extra_monthly) * 100) : p.extraCents;
      const start = p.startMonth as YearMonth;
      const lumps = ((input.lumps as { month: string; amount: number }[]) ?? []).map((l) => ({
        month: Math.max(1, (Number(l.month.slice(0, 4)) - Number(start.slice(0, 4))) * 12 + Number(l.month.slice(5, 7)) - Number(start.slice(5, 7)) + 1), amount: Math.round(l.amount * 100) }));
      const r = simulatePayoff({ loans: p.loans, extraMonthly: extra, strategy, lumps });
      const label = (m: number) => addMonths(start, m - 1);
      return { strategy, extra_per_month: d(extra), debt_free: label(r.months), total_interest: d(r.totalInterest), each_paid_off: Object.fromEntries(Object.entries(r.paidOffMonth).map(([id, m]) => [p.loans.find((l) => l.id === id)?.name ?? id, label(m)])),
        compared_to_current_plan: { debt_free: p.current.doneLabel, total_interest: d(p.current.totalInterest) }, note: 'Does not include the yearly one-time income already in the plan unless you add it as lumps.' };
    }
    default: return { error: `Unknown tool ${name}` };
  }
}

type Block = { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> };

export class Assistant {
  constructor(private apiKey: string, readonly model = 'claude-haiku-5-5', private fetchImpl: typeof fetch = fetch) {}

  /** One answer: lets Claude call tools (up to 8 rounds), then returns its final text and which tools it used. */
  async answer(db: Db, hid: string, history: { role: 'user' | 'assistant'; content: string }[], who: string): Promise<{ text: string; tools: string[] }> {
    const today = householdToday();
    const system = [
      `You are Hearth, the money assistant inside Jason and Renee's household budgeting app (Columbus, Ohio). You're talking with ${who}. Today is ${today}.`,
      'Answer from their data by calling the tools; never guess numbers. Call only the tools a question needs. Use their category and payee names.',
      'How they run money: zero-based budget; paychecks Jason on the 15th and 30th, Renee on the 10th and 25th (earlier business day on weekends); the 25th and 30th checks carry them to the 10th (rent on the 1st).',
      'They pay most everyday spending with cash envelopes (fill-and-forget: filling an envelope counts as spending); tithe, rent, utilities, subscriptions, insurance and loans are paid from Kemba checking.',
      'Leftover envelope cash goes to a Leftovers fund. They follow Dave Ramsey-style principles: aggressive student-loan payoff (snowball by default), emergency fund, and avoiding small debit-card purchases.',
      'Be brief and concrete: lead with the answer, then the few numbers that support it (dollars, dates). Use short lists when comparing. Say plainly when data is missing or an estimate.',
      "You can't change anything in the app yet; if they want a change, tell them where to do it (Budget row panel, Transactions, Calendar → Paychecks, Goals).",
      'For big decisions, give the trade-offs; you are not a licensed financial advisor, but don\'t pad answers with disclaimers.',
    ].join('\n');
    const messages: { role: string; content: unknown }[] = history.slice(-20).map((m) => ({ role: m.role, content: m.content }));
    const used: string[] = [];
    for (let round = 0; round < 8; round++) {
      const res = await this.fetchImpl('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.model, max_tokens: 1500, system, tools: TOOLS, messages }),
      });
      if (!res.ok) throw new Error(`Claude request failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
      const data = (await res.json()) as { content: Block[]; stop_reason: string };
      const calls = data.content.filter((b) => b.type === 'tool_use');
      if (data.stop_reason !== 'tool_use' || !calls.length) {
        return { text: data.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim() || "I couldn't put an answer together. Try asking another way.", tools: used };
      }
      messages.push({ role: 'assistant', content: data.content });
      const results = [];
      for (const c of calls) {
        used.push(c.name!);
        let out: unknown;
        try { out = await runTool(db, hid, c.name!, c.input ?? {}); } catch (e) { out = { error: (e as Error).message }; }
        results.push({ type: 'tool_result', tool_use_id: c.id, content: JSON.stringify(out).slice(0, 60_000) });
      }
      messages.push({ role: 'user', content: results });
    }
    return { text: 'That took more steps than I allow for one question. Try narrowing it down (a month, a category or a payee).', tools: used };
  }
}

export function assistantFromEnv(env = process.env): Assistant | null {
  return env.ANTHROPIC_API_KEY ? new Assistant(env.ANTHROPIC_API_KEY, env.HEARTH_ASSISTANT_MODEL || undefined) : null;
}
