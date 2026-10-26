import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import { z } from 'zod';
import { parseCents, subtreeIds, wouldCycle, type YearMonth } from '@hearth/core';
import type { Db } from './db';
import { createSession, hashPassword, newId, userForSession, verifyPassword, type SessionUser } from './auth';
import { budgetView, calendarView, categoryRows, planView, setPlanned } from './services';

declare module 'fastify' {
  interface FastifyRequest {
    user?: SessionUser;
  }
}

const COOKIE = 'hearth_session';
const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const money = z.union([z.number(), z.string()]).transform((v) => parseCents(v));

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
const notFound = () => new HttpError(404, 'Not found');

export function currentMonth(now = new Date()): YearMonth {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

export async function buildApp(db: Db, opts: { webOrigin?: string; secureCookies?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(cookie);
  await app.register(cors, { origin: opts.webOrigin ?? true, credentials: true });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message });
    if (err instanceof z.ZodError) return reply.status(400).send({ error: 'Invalid input', issues: err.issues });
    reply.status(500).send({ error: 'Something went wrong' });
  });

  // Every /api route except auth requires a signed-in household member.
  app.addHook('preHandler', async (req) => {
    if (!req.url.startsWith('/api/') || req.url.startsWith('/api/auth/') || req.url === '/api/health') return;
    const user = await userForSession(db, req.cookies[COOKIE]);
    if (!user) throw new HttpError(401, 'Sign in required');
    req.user = user;
  });
  const hid = (req: FastifyRequest) => req.user!.householdId;

  /** Confirms a category belongs to this household. */
  const ownCategory = async (req: FastifyRequest, id: string) => {
    const r = await db.query<{ id: string; parent_id: string | null; name: string }>('SELECT id, parent_id, name FROM categories WHERE id = $1 AND household_id = $2 AND NOT archived', [id, hid(req)]);
    if (!r[0]) throw notFound();
    return r[0];
  };
  const nextSort = async (householdId: string, parentId: string | null) => {
    const r = await db.query<{ n: number | null }>('SELECT MAX(sort_order) AS n FROM categories WHERE household_id = $1 AND parent_id IS NOT DISTINCT FROM $2 AND NOT archived', [householdId, parentId]);
    return (r[0]?.n ?? -1) + 1;
  };
  /** A leaf that gains children hands its money to a "General" child first, so nothing planned is lost. */
  const ensureParent = async (householdId: string, id: string, month: YearMonth) => {
    const kids = await db.query('SELECT 1 FROM categories WHERE parent_id = $1 AND NOT archived LIMIT 1', [id]);
    if (kids.length) return;
    const own = await db.query<{ planned_cents: number }>('SELECT planned_cents FROM budgets WHERE category_id = $1 AND month <= $2 ORDER BY month DESC LIMIT 1', [id, month]);
    const planned = own[0]?.planned_cents ?? 0;
    const txns = await db.query('SELECT 1 FROM transactions WHERE category_id = $1 LIMIT 1', [id]);
    if (planned === 0 && !txns.length) return;
    const gid = newId();
    await db.query("INSERT INTO categories (id, household_id, parent_id, name, kind, sort_order) SELECT $1, household_id, id, 'General', kind, 0 FROM categories WHERE id = $2", [gid, id]);
    await setPlanned(db, gid, month, planned);
    await setPlanned(db, id, month, 0);
    await db.query('UPDATE transactions SET category_id = $1 WHERE category_id = $2', [gid, id]);
  };

  app.get('/api/health', async () => ({ ok: true }));

  // ---------- auth ----------
  app.post('/api/auth/login', async (req, reply) => {
    const body = z.object({ email: z.string().email(), password: z.string().min(1) }).parse(req.body);
    const u = (await db.query<{ id: string; password_hash: string | null }>('SELECT id, password_hash FROM users WHERE lower(email) = lower($1)', [body.email]))[0];
    if (!u || !(await verifyPassword(body.password, u.password_hash))) throw new HttpError(401, 'Email or password is incorrect');
    const sid = await createSession(db, u.id);
    reply.setCookie(COOKIE, sid, { path: '/', httpOnly: true, sameSite: 'lax', secure: !!opts.secureCookies, maxAge: 60 * 60 * 24 * 30 });
    return { ok: true };
  });
  app.post('/api/auth/logout', async (req, reply) => {
    const sid = req.cookies[COOKIE];
    if (sid) await db.query('DELETE FROM sessions WHERE id = $1', [sid]);
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });
  app.get('/api/me', async (req) => req.user);
  app.post('/api/me/password', async (req) => {
    const body = z.object({ current: z.string(), next: z.string().min(10, 'Use at least 10 characters') }).parse(req.body);
    const u = (await db.query<{ password_hash: string | null }>('SELECT password_hash FROM users WHERE id = $1', [req.user!.id]))[0];
    if (!(await verifyPassword(body.current, u?.password_hash ?? null))) throw new HttpError(400, 'Current password is incorrect');
    await db.query('UPDATE users SET password_hash = $1, must_change_password = FALSE WHERE id = $2', [await hashPassword(body.next), req.user!.id]);
    return { ok: true };
  });

  // ---------- budget & categories ----------
  app.get('/api/budget', async (req) => {
    const q = z.object({ month: monthSchema.optional() }).parse(req.query);
    return budgetView(db, hid(req), q.month ?? currentMonth());
  });

  app.post('/api/categories', async (req) => {
    const b = z.object({ name: z.string().trim().min(1).max(80), parentId: z.string().nullable().optional(), planned: money.optional(), month: monthSchema, kind: z.string().optional() }).parse(req.body);
    const parentId = b.parentId ?? null;
    if (parentId) { await ownCategory(req, parentId); await ensureParent(hid(req), parentId, b.month); }
    const id = newId();
    await db.query('INSERT INTO categories (id, household_id, parent_id, name, kind, sort_order) VALUES ($1,$2,$3,$4,$5,$6)', [id, hid(req), parentId, b.name, b.kind ?? 'everyday', await nextSort(hid(req), parentId)]);
    await setPlanned(db, id, b.month, b.planned ?? 0);
    return { id };
  });

  app.patch('/api/categories/:id', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const b = z.object({ name: z.string().trim().min(1).max(80).optional(), parentId: z.string().nullable().optional(), sortOrder: z.number().int().optional(), planned: money.optional(), month: monthSchema.optional() }).parse(req.body);
    await ownCategory(req, id);
    if (b.name !== undefined) await db.query('UPDATE categories SET name = $1 WHERE id = $2', [b.name, id]);
    if (b.parentId !== undefined) {
      if (b.parentId) await ownCategory(req, b.parentId);
      const rows = await categoryRows(db, hid(req), b.month ?? currentMonth());
      if (wouldCycle(rows, id, b.parentId)) throw new HttpError(400, 'A category cannot go inside itself');
      if (b.parentId) await ensureParent(hid(req), b.parentId, b.month ?? currentMonth());
      await db.query('UPDATE categories SET parent_id = $1, sort_order = $2 WHERE id = $3', [b.parentId, await nextSort(hid(req), b.parentId), id]);
    }
    if (b.sortOrder !== undefined) await db.query('UPDATE categories SET sort_order = $1 WHERE id = $2', [b.sortOrder, id]);
    if (b.planned !== undefined) {
      const kids = await db.query('SELECT 1 FROM categories WHERE parent_id = $1 AND NOT archived LIMIT 1', [id]);
      if (kids.length) throw new HttpError(400, 'Set amounts on the categories inside a parent');
      await setPlanned(db, id, b.month ?? currentMonth(), b.planned);
    }
    return { ok: true };
  });

  /** Turns a category into a parent: its money moves to a "General" subcategory. */
  app.post('/api/categories/:id/split', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const b = z.object({ month: monthSchema }).parse(req.body);
    await ownCategory(req, id);
    const kids = await db.query('SELECT 1 FROM categories WHERE parent_id = $1 AND NOT archived LIMIT 1', [id]);
    if (kids.length) return { ok: true };
    const gid = newId();
    const own = await db.query<{ planned_cents: number }>('SELECT planned_cents FROM budgets WHERE category_id = $1 AND month <= $2 ORDER BY month DESC LIMIT 1', [id, b.month]);
    await db.query("INSERT INTO categories (id, household_id, parent_id, name, kind, sort_order) SELECT $1, household_id, id, 'General', kind, 0 FROM categories WHERE id = $2", [gid, id]);
    await setPlanned(db, gid, b.month, own[0]?.planned_cents ?? 0);
    await setPlanned(db, id, b.month, 0);
    await db.query('UPDATE transactions SET category_id = $1 WHERE category_id = $2', [gid, id]);
    return { ok: true, generalId: gid };
  });

  /** Moves categories under an existing parent, or under a new parent created by name. */
  app.post('/api/categories/group', async (req) => {
    const b = z.object({ ids: z.array(z.string()).min(1), parentId: z.string().optional(), newParentName: z.string().trim().min(1).max(80).optional(), month: monthSchema }).parse(req.body);
    for (const id of b.ids) await ownCategory(req, id);
    let parentId = b.parentId;
    if (!parentId) {
      const name = b.newParentName ?? 'Other';
      const existing = await db.query<{ id: string }>('SELECT id FROM categories WHERE household_id = $1 AND parent_id IS NULL AND lower(name) = lower($2) AND NOT archived', [hid(req), name]);
      parentId = existing[0]?.id;
      if (!parentId) {
        parentId = newId();
        await db.query('INSERT INTO categories (id, household_id, parent_id, name, kind, sort_order) VALUES ($1,$2,NULL,$3,$4,$5)', [parentId, hid(req), name, 'everyday', await nextSort(hid(req), null)]);
      }
    } else await ownCategory(req, parentId);
    const rows = await categoryRows(db, hid(req), b.month);
    for (const id of b.ids) if (wouldCycle(rows, id, parentId)) throw new HttpError(400, 'A category cannot go inside itself');
    await ensureParent(hid(req), parentId, b.month);
    for (const id of b.ids) await db.query('UPDATE categories SET parent_id = $1, sort_order = $2 WHERE id = $3', [parentId, await nextSort(hid(req), parentId), id]);
    return { parentId };
  });

  /** mode=all archives the category and everything inside it; mode=ungroup lifts its children up a level first. Restorable. */
  app.delete('/api/categories/:id', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { mode } = z.object({ mode: z.enum(['all', 'ungroup']).default('all') }).parse(req.query);
    const cat = await ownCategory(req, id);
    const rows = await categoryRows(db, hid(req), currentMonth());
    if (mode === 'ungroup') {
      await db.query('UPDATE categories SET parent_id = $1 WHERE parent_id = $2', [cat.parent_id, id]);
      await db.query('UPDATE categories SET archived = TRUE WHERE id = $1', [id]);
      return { archived: [id] };
    }
    const ids = [...subtreeIds(rows, id)];
    await db.query('UPDATE categories SET archived = TRUE WHERE id = ANY($1)', [ids]);
    return { archived: ids };
  });

  app.post('/api/categories/restore', async (req) => {
    const b = z.object({ ids: z.array(z.string()).min(1) }).parse(req.body);
    await db.query('UPDATE categories SET archived = FALSE WHERE id = ANY($1) AND household_id = $2', [b.ids, hid(req)]);
    return { ok: true };
  });

  // ---------- transactions ----------
  app.get('/api/transactions', async (req) => {
    const q = z.object({ month: monthSchema.optional() }).parse(req.query);
    return db.query(
      `SELECT t.id, to_char(t.date, 'YYYY-MM-DD') AS date, t.amount_cents, t.merchant, t.category_id, c.name AS category_name, t.source, t.note, t.pending
       FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
       WHERE t.household_id = $1 AND to_char(t.date, 'YYYY-MM') = $2 ORDER BY t.date DESC, t.created_at DESC`,
      [hid(req), q.month ?? currentMonth()],
    );
  });
  const txnBody = z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    /** Positive = money out (spending), negative = money in. Matches how people type a purchase. */
    amount: money,
    merchant: z.string().trim().min(1).max(120),
    categoryId: z.string().nullable().optional(),
    note: z.string().max(500).optional(),
  });
  app.post('/api/transactions', async (req) => {
    const b = txnBody.parse(req.body);
    if (b.categoryId) await ownCategory(req, b.categoryId);
    const id = newId();
    await db.query("INSERT INTO transactions (id, household_id, date, amount_cents, merchant, category_id, source, note, created_by) VALUES ($1,$2,$3,$4,$5,$6,'manual',$7,$8)",
      [id, hid(req), b.date, -b.amount, b.merchant, b.categoryId ?? null, b.note ?? null, req.user!.id]);
    return { id };
  });
  app.patch('/api/transactions/:id', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const b = txnBody.partial().parse(req.body);
    if (b.categoryId) await ownCategory(req, b.categoryId);
    const sets: string[] = [];
    const vals: unknown[] = [];
    const add = (col: string, v: unknown) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
    if (b.date !== undefined) add('date', b.date);
    if (b.amount !== undefined) add('amount_cents', -b.amount);
    if (b.merchant !== undefined) add('merchant', b.merchant);
    if (b.categoryId !== undefined) { add('category_id', b.categoryId); add('source', 'you'); }
    if (b.note !== undefined) add('note', b.note);
    if (!sets.length) return { ok: true };
    vals.push(id, hid(req));
    const r = await db.query(`UPDATE transactions SET ${sets.join(', ')} WHERE id = $${vals.length - 1} AND household_id = $${vals.length} RETURNING id`, vals);
    if (!r.length) throw notFound();
    return { ok: true };
  });
  app.delete('/api/transactions/:id', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await db.query('DELETE FROM transactions WHERE id = $1 AND household_id = $2', [id, hid(req)]);
    return { ok: true };
  });

  // ---------- calendar ----------
  app.get('/api/calendar', async (req) => {
    const q = z.object({ month: monthSchema.optional() }).parse(req.query);
    return calendarView(db, hid(req), q.month ?? currentMonth());
  });

  // ---------- loans, goals, one-time income ----------
  app.get('/api/plan', async (req) => planView(db, hid(req)));
  app.put('/api/plan', async (req) => {
    const b = z.object({ strategy: z.enum(['snowball', 'avalanche']).optional(), extra: money.optional() }).parse(req.body);
    if (b.strategy) await db.query('UPDATE loan_plans SET strategy = $1 WHERE household_id = $2', [b.strategy, hid(req)]);
    if (b.extra !== undefined) await db.query('UPDATE loan_plans SET extra_cents = $1 WHERE household_id = $2', [Math.max(0, b.extra), hid(req)]);
    return planView(db, hid(req));
  });

  const eventBody = z.object({
    name: z.string().trim().min(1).max(80),
    kind: z.enum(['one_time', 'raise']).default('one_time'),
    month: monthSchema,
    amount: money,
    destination: z.enum(['loans', 'emergency', 'split']).default('loans'),
    enabled: z.boolean().default(true),
    repeatsYearly: z.boolean().default(false),
    note: z.string().max(300).optional(),
  });
  app.post('/api/income-events', async (req) => {
    const b = eventBody.parse(req.body);
    const id = newId();
    await db.query('INSERT INTO income_events (id, household_id, name, kind, month, amount_cents, destination, enabled, repeats_yearly, note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [id, hid(req), b.name, b.kind, b.month, b.amount, b.destination, b.enabled, b.repeatsYearly, b.note ?? null]);
    return { id };
  });
  app.patch('/api/income-events/:id', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const b = eventBody.partial().parse(req.body);
    const map: Record<string, string> = { name: 'name', kind: 'kind', month: 'month', amount: 'amount_cents', destination: 'destination', enabled: 'enabled', repeatsYearly: 'repeats_yearly', note: 'note' };
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(b)) if (v !== undefined && map[k]) { vals.push(v); sets.push(`${map[k]} = $${vals.length}`); }
    if (sets.length) {
      vals.push(id, hid(req));
      const r = await db.query(`UPDATE income_events SET ${sets.join(', ')} WHERE id = $${vals.length - 1} AND household_id = $${vals.length} RETURNING id`, vals);
      if (!r.length) throw notFound();
    }
    return { ok: true };
  });
  app.delete('/api/income-events/:id', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await db.query('DELETE FROM income_events WHERE id = $1 AND household_id = $2', [id, hid(req)]);
    return { ok: true };
  });

  return app;
}
