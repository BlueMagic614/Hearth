import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Db } from './db';
import { newId } from './auth';
import { HttpError, notFound } from './errors';
import { assignToCheck, autoPlace, paycheckPlan, payerByCategory } from './paychecks';
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
    const r = await assignToCheck(db, hid(req), b.categoryId, b.payDay, newId);
    if (r === 'missing') throw notFound();
    if (r === 'no-amount') throw new HttpError(400, 'Plan an amount for it first');
    return { ok: true };
  });

  /** Let Hearth decide which checks pay savings moves and extra debt payments. Preview first; apply to save. */
  app.post('/api/paychecks/auto', async (req) => {
    const b = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(), apply: z.boolean().optional() }).parse(req.body ?? {});
    const proposal = await autoPlace(db, hid(req), (b.month ?? currentMonth()) as never);
    if (b.apply) for (const p of proposal.placements) await assignToCheck(db, hid(req), p.categoryId, p.payDay, newId);
    return { ...proposal, applied: !!b.apply };
  });
}
