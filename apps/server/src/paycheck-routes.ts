import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Db } from './db';
import { newId } from './auth';
import { HttpError, notFound } from './errors';
import { paycheckPlan, payerByCategory } from './paychecks';
import { currentMonth } from './time';

export async function registerPaycheckRoutes(app: FastifyInstance, db: Db, { hid }: { hid: (req: FastifyRequest) => string }) {
  app.get('/api/paychecks', async (req) => {
    const { month = currentMonth() } = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional() }).parse(req.query);
    const plan = await paycheckPlan(db, hid(req), month);
    const paydays = (await db.query<{ person: string; days: number[]; amount_cents: number }>('SELECT person, days, amount_cents FROM income_sources WHERE household_id = $1', [hid(req)]))
      .flatMap((r) => r.days.map((d) => ({ person: r.person, day: d, amount: r.amount_cents }))).sort((a, b) => a.day - b.day);
    return { ...plan, payers: payerByCategory(plan), paydays };
  });

  /** Pay a monthly item (savings move, extra debt payment) out of a particular check, every month. */
  app.post('/api/paychecks/assign', async (req) => {
    const b = z.object({ categoryId: z.string(), payDay: z.number().int().min(1).max(31) }).parse(req.body);
    const cat = (await db.query<{ id: string; name: string; kind: string | null; planned: number | null }>(
      `SELECT c.id, c.name, c.kind, (SELECT planned_cents FROM budgets b WHERE b.category_id = c.id ORDER BY month DESC LIMIT 1) AS planned
       FROM categories c WHERE c.id = $1 AND c.household_id = $2 AND NOT c.archived`, [b.categoryId, hid(req)]))[0];
    if (!cat) throw notFound();
    const existing = (await db.query<{ id: string }>('SELECT id FROM schedules WHERE category_id = $1', [cat.id]))[0];
    if (existing) {
      await db.query("UPDATE schedules SET days = $1, cadence = 'monthly', on_payday = TRUE, date_source = 'manual', window_days = 0 WHERE id = $2", [[b.payDay], existing.id]);
    } else {
      if (!cat.planned) throw new HttpError(400, 'Plan an amount for it first');
      await db.query(
        `INSERT INTO schedules (id, household_id, name, kind, amount_cents, cadence, days, weekend_rule, category_id, date_source, window_days, on_payday)
         VALUES ($1,$2,$3,$4,$5,'monthly',$6,'before',$7,'manual',0,TRUE)`,
        [newId(), hid(req), cat.name, cat.kind === 'savings' ? 'save' : 'bill', -cat.planned, [b.payDay], cat.id]);
    }
    return { ok: true };
  });
}
