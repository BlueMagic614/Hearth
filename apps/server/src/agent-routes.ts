import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { addDays, type ISODate } from '@hearth/core';
import type { Db } from './db';
import { leavesFor, runAgent, type PayeeClassifier } from './agent';
import { HttpError } from './errors';
import { setPlanned } from './services';
import { householdToday } from './time';

interface Opts { classifier: PayeeClassifier | null; hid: (req: FastifyRequest) => string }

const daysBetween = (a: ISODate, b: ISODate) => Math.round((Date.parse(b) - Date.parse(a)) / 86400_000);

/**
 * Average monthly spending per everyday category over the last 90 days (or since history begins),
 * rounded up to the next $5, next to what's planned now.
 */
export async function budgetSuggestions(db: Db, hid: string, month: string, today: ISODate, windowDays = 90) {
  const end = addDays(today, -1);
  let start = addDays(end, -(windowDays - 1));
  const first = (await db.query<{ d: string | null }>("SELECT to_char(MIN(date), 'YYYY-MM-DD') AS d FROM transactions WHERE household_id = $1 AND external_id IS NOT NULL", [hid]))[0]?.d;
  if (!first) return { ready: false as const, reason: 'Connect Kemba first: suggestions come from your real spending.' };
  if (first > start) start = first;
  const days = daysBetween(start, end) + 1;
  if (days < 28) return { ready: false as const, reason: `Only ${days} days of history so far. Suggestions need about a month.` };

  const leaves = (await leavesFor(db, hid)).filter((l) => l.kind === 'everyday');
  const spent = new Map((await db.query<{ category_id: string; total: unknown; n: unknown }>(
    `SELECT category_id, -SUM(amount_cents) AS total, COUNT(*) AS n FROM transactions
     WHERE household_id = $1 AND flow = 'spend' AND category_id IS NOT NULL AND date BETWEEN $2 AND $3 GROUP BY category_id`, [hid, start, end])).map((r) => [r.category_id, { total: Number(r.total), n: Number(r.n) }]));
  const planned = new Map((await db.query<{ category_id: string; planned_cents: number }>(
    `SELECT DISTINCT ON (b.category_id) b.category_id, b.planned_cents FROM budgets b JOIN categories c ON c.id = b.category_id
     WHERE c.household_id = $1 AND b.month <= $2 ORDER BY b.category_id, b.month DESC`, [hid, month])).map((r) => [r.category_id, r.planned_cents]));
  const unsorted = (await db.query<{ total: unknown; n: unknown }>(
    `SELECT COALESCE(-SUM(amount_cents), 0) AS total, COUNT(*) AS n FROM transactions
     WHERE household_id = $1 AND flow = 'spend' AND category_id IS NULL AND amount_cents < 0 AND date BETWEEN $2 AND $3`, [hid, start, end]))[0]!;

  const perMonth = 30.44 / days;
  return {
    ready: true as const,
    start, end, days,
    unsorted: { count: Number(unsorted.n), total: Number(unsorted.total) },
    items: leaves.map((l) => {
      const s = spent.get(l.id) ?? { total: 0, n: 0 };
      const monthly = Math.max(0, Math.round(s.total * perMonth));
      return { categoryId: l.id, path: l.path, current: planned.get(l.id) ?? 0, monthly, suggested: Math.ceil(monthly / 500) * 500, count: s.n };
    }),
  };
}

export async function registerAgentRoutes(app: FastifyInstance, db: Db, { classifier, hid }: Opts) {
  app.get('/api/review', async (req) => {
    const items = await db.query(
      `SELECT t.id, to_char(t.date, 'YYYY-MM-DD') AS date, t.amount_cents, t.merchant, t.pending, t.bank_category,
              t.suggested_category_id, c.name AS suggested_name, t.confidence
       FROM transactions t LEFT JOIN categories c ON c.id = t.suggested_category_id
       WHERE t.household_id = $1 AND t.needs_review AND t.category_id IS NULL ORDER BY t.date DESC LIMIT 300`, [hid(req)]);
    return { count: items.length, items };
  });

  app.get('/api/agent/status', async () => ({ claude: !!classifier }));

  app.post('/api/agent/run', async (req) => runAgent(db, hid(req), { classifier, today: householdToday() }));

  /** Accept several suggestions at once (each becomes the household's own choice, so the model learns from it). */
  app.post('/api/review/accept', async (req) => {
    const b = z.object({ ids: z.array(z.string()).min(1).max(300) }).parse(req.body);
    const r = await db.query(
      `UPDATE transactions SET category_id = suggested_category_id, source = 'you', needs_review = FALSE, suggested_category_id = NULL
       WHERE household_id = $1 AND id = ANY($2) AND needs_review AND suggested_category_id IS NOT NULL RETURNING id`, [hid(req), b.ids]);
    await runAgent(db, hid(req), { classifier, today: householdToday() });
    return { accepted: r.length };
  });

  app.get('/api/budget/suggestions', async (req) => {
    const q = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) }).parse(req.query);
    return budgetSuggestions(db, hid(req), q.month, householdToday());
  });

  app.post('/api/budget/apply', async (req) => {
    const b = z.object({
      month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
      items: z.array(z.object({ categoryId: z.string(), amount: z.number().int().min(0).max(100_000_00) })).min(1),
    }).parse(req.body);
    const own = new Set((await leavesFor(db, hid(req))).map((l) => l.id));
    if (b.items.some((i) => !own.has(i.categoryId))) throw new HttpError(400, 'Unknown category');
    for (const i of b.items) await setPlanned(db, i.categoryId, b.month, i.amount);
    return { ok: true, updated: b.items.length };
  });
}
