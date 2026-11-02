import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Db } from './db';
import { envelopes, leftoverBalance, moveLeftovers, recommendLeftovers, writeSplit } from './cash';
import { HttpError, notFound } from './errors';
import { currentMonth, householdToday } from './time';

const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const cents = z.number().int().min(0).max(10_000_000);

export async function registerCashRoutes(app: FastifyInstance, db: Db, { hid }: { hid: (req: FastifyRequest) => string }) {
  /** The month's envelopes, withdrawals and their splits, plus the Leftovers fund and where it should go. */
  app.get('/api/cash', async (req) => {
    const { month = currentMonth() } = z.object({ month: monthSchema.optional() }).parse(req.query);
    const h = hid(req);
    const env = await envelopes(db, h, month);
    const withdrawals = await db.query<{ id: string; date: string; amount_cents: number; merchant: string; pending: boolean }>(
      `SELECT id, to_char(date, 'YYYY-MM-DD') AS date, amount_cents, merchant, pending FROM transactions
       WHERE household_id = $1 AND flow = 'cash' AND COALESCE(budget_month, to_char(date, 'YYYY-MM')) = $2 ORDER BY date`, [h, month]);
    const fills = await db.query<{ transaction_id: string | null; category_id: string | null; name: string | null; amount_cents: number; kind: string }>(
      `SELECT f.transaction_id, f.category_id, c.name, f.amount_cents, f.kind FROM cash_fills f LEFT JOIN categories c ON c.id = f.category_id
       WHERE f.household_id = $1 AND f.month = $2`, [h, month]);
    const balance = await leftoverBalance(db, h);
    return {
      month,
      envelopes: env,
      toFill: env.reduce((s, e) => s + Math.max(0, e.planned - e.filled), 0),
      plannedCash: env.reduce((s, e) => s + e.planned, 0),
      unassigned: fills.filter((f) => f.kind === 'fill' && !f.category_id).reduce((s, f) => s + f.amount_cents, 0),
      leftoverCounted: -fills.filter((f) => f.kind === 'leftover').reduce((s, f) => s + f.amount_cents, 0),
      withdrawals: withdrawals.map((w) => ({
        ...w, fills: fills.filter((f) => f.transaction_id === w.id && f.kind === 'fill').map((f) => ({ categoryId: f.category_id, name: f.name, amount: f.amount_cents })),
      })),
      leftovers: { balance, ...(await recommendLeftovers(db, h, balance, householdToday())) },
    };
  });

  /** Change how a withdrawal is split between envelopes. The parts must add up to the withdrawal. */
  app.put('/api/cash/withdrawals/:id', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const b = z.object({ parts: z.array(z.object({ categoryId: z.string().nullable(), amount: cents })).min(1) }).parse(req.body);
    const t = (await db.query<{ amount_cents: number; month: string }>(
      "SELECT amount_cents, COALESCE(budget_month, to_char(date, 'YYYY-MM')) AS month FROM transactions WHERE id = $1 AND household_id = $2 AND flow = 'cash'", [id, hid(req)]))[0];
    if (!t) throw notFound();
    const sum = b.parts.reduce((s, p) => s + p.amount, 0);
    if (sum !== -t.amount_cents) throw new HttpError(400, `The envelopes add up to $${(sum / 100).toFixed(2)}, but the withdrawal was $${(-t.amount_cents / 100).toFixed(2)}.`);
    const own = new Set((await db.query<{ id: string }>('SELECT id FROM categories WHERE household_id = $1 AND cash', [hid(req)])).map((r) => r.id));
    if (b.parts.some((p) => p.categoryId && !own.has(p.categoryId))) throw new HttpError(400, 'Only cash categories can hold cash');
    await writeSplit(db, hid(req), id, t.month, b.parts, req.user!.id);
    return { ok: true };
  });

  /** Count cash left at month end: it comes back out of those envelopes (so spending is accurate) into Leftovers. */
  app.post('/api/cash/leftovers', async (req) => {
    const b = z.object({ month: monthSchema, items: z.array(z.object({ categoryId: z.string().nullable(), amount: cents })).min(1) }).parse(req.body);
    const own = new Set((await db.query<{ id: string }>('SELECT id FROM categories WHERE household_id = $1 AND cash', [hid(req)])).map((r) => r.id));
    if (b.items.some((i) => i.categoryId && !own.has(i.categoryId))) throw new HttpError(400, 'Unknown cash category');
    await db.query("DELETE FROM cash_fills WHERE household_id = $1 AND month = $2 AND kind = 'leftover'", [hid(req), b.month]);
    for (const i of b.items) {
      if (!i.amount) continue;
      await db.query("INSERT INTO cash_fills (id, household_id, category_id, month, amount_cents, kind, created_by) VALUES (gen_random_uuid()::text,$1,$2,$3,$4,'leftover',$5)",
        [hid(req), i.categoryId, b.month, -i.amount, req.user!.id]);
    }
    return { ok: true, balance: await leftoverBalance(db, hid(req)) };
  });

  /** Move money out of the Leftovers fund to a goal, a loan, or back to checking. */
  app.post('/api/cash/leftovers/move', async (req) => {
    const b = z.object({ amount: cents.min(1), destination: z.enum(['checking', 'goal', 'loan']), targetId: z.string().nullable().optional() }).parse(req.body);
    const balance = await leftoverBalance(db, hid(req));
    if (b.amount > balance) throw new HttpError(400, 'That is more than the Leftovers fund holds');
    if (b.destination !== 'checking' && !b.targetId) throw new HttpError(400, 'Choose where it goes');
    const name = await moveLeftovers(db, hid(req), req.user!.id, currentMonth(), b.amount, b.destination, b.targetId ?? null).catch((e: Error) => { throw new HttpError(400, e.message); });
    return { ok: true, to: name, balance: await leftoverBalance(db, hid(req)) };
  });
}
