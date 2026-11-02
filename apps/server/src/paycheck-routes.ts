import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Db } from './db';
import { newId } from './auth';
import { HttpError, notFound } from './errors';
import { assignToCheck, autoPlace, paycheckPlan, payerByCategory } from './paychecks';
import { currentMonth } from './time';
import { getSetting, putSetting, schedulesFor } from './services';

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

  /** Mark a line of "Right now" as already paid or covered (a payment Kemba hasn't sent yet, cash pulled earlier). */
  app.post('/api/paychecks/covered', async (req) => {
    const b = z.object({ halfId: z.string(), key: z.string(), covered: z.boolean() }).parse(req.body);
    const all = await getSetting<Record<string, string[]>>(db, hid(req), 'paycheck_covered', {});
    const set = new Set(all[b.halfId] ?? []);
    if (b.covered) set.add(b.key); else set.delete(b.key);
    all[b.halfId] = [...set];
    // Keep only recent halves.
    const keep = Object.keys(all).sort((x, y) => (x.split('|')[1] ?? '').localeCompare(y.split('|')[1] ?? '')).slice(-6);
    await putSetting(db, hid(req), 'paycheck_covered', Object.fromEntries(keep.map((k) => [k, all[k]!])));
    return { ok: true };
  });

  /** Scheduled bills and savings moves (for settings like flexible timing). */
  app.get('/api/schedules', async (req) =>
    (await schedulesFor(db, hid(req))).filter((x) => x.kind !== 'pay').map((x) => ({ id: x.id, name: x.name, categoryId: x.categoryId ?? null, days: x.days, flexible: !!x.flexible, months: x.months ?? null })));
}
