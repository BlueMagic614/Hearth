import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { BankProvider } from './bank';
import { encrypt, decrypt } from './crypto';
import type { Db } from './db';
import { newId } from './auth';
import { HttpError, notFound } from './errors';
import { syncConnection } from './sync';
import type { PayeeClassifier } from './agent';

interface Opts { bank: BankProvider | null; hid: (req: FastifyRequest) => string; webhookDelayMs?: number; classifier?: PayeeClassifier | null }

/**
 * Kemba via Plaid: link token → Plaid Link in the browser → public token exchanged here for an access token
 * (encrypted at rest) → sync. Plaid then calls the webhook whenever new transactions are ready.
 */
export async function registerBankRoutes(app: FastifyInstance, db: Db, { bank, hid, webhookDelayMs = 2000, classifier = null }: Opts) {
  const need = () => {
    if (!bank) throw new HttpError(503, "Bank connection isn't set up on the server yet (Plaid keys missing).");
    return bank;
  };
  const ownConnection = async (req: FastifyRequest, id: string) => {
    const r = await db.query<{ id: string; access_token_enc: string }>('SELECT id, access_token_enc FROM bank_connections WHERE id = $1 AND household_id = $2', [id, hid(req)]);
    if (!r[0]) throw notFound();
    return r[0];
  };

  // One sync at a time per connection; webhooks that arrive together collapse into one run.
  const running = new Map<string, Promise<unknown>>();
  const timers = new Map<string, NodeJS.Timeout>();
  const runSync = (connId: string) => {
    const existing = running.get(connId);
    if (existing) return existing;
    const p = syncConnection(db, need(), connId, { classifier }).finally(() => running.delete(connId));
    running.set(connId, p);
    return p;
  };
  const syncSoon = (connId: string) => {
    clearTimeout(timers.get(connId));
    timers.set(connId, setTimeout(() => { timers.delete(connId); runSync(connId).catch(() => {}); }, webhookDelayMs));
  };
  app.addHook('onClose', async () => { for (const t of timers.values()) clearTimeout(t); });

  app.post('/api/plaid/link-token', async (req) => {
    const b = need();
    const { connectionId } = z.object({ connectionId: z.string().optional() }).parse(req.body ?? {});
    const accessToken = connectionId ? decrypt((await ownConnection(req, connectionId)).access_token_enc) : undefined;
    const base = process.env.RENDER_EXTERNAL_URL ?? process.env.PUBLIC_URL;
    const linkToken = await b.createLinkToken({ userId: req.user!.id, accessToken, webhookUrl: base ? `${base.replace(/\/$/, '')}/api/plaid/webhook` : undefined });
    return { linkToken, environment: b.environment };
  });

  app.post('/api/plaid/exchange', async (req) => {
    const b = need();
    const body = z.object({
      publicToken: z.string().min(1),
      institution: z.object({ id: z.string().optional(), name: z.string().optional() }).optional(),
    }).parse(req.body);
    const { accessToken, itemId } = await b.exchangePublicToken(body.publicToken);
    const id = newId();
    await db.query(
      `INSERT INTO bank_connections (id, household_id, user_id, environment, item_id, access_token_enc, institution_id, institution_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, hid(req), req.user!.id, b.environment, itemId, encrypt(accessToken), body.institution?.id ?? null, body.institution?.name ?? 'Kemba Financial Credit Union'],
    );
    try {
      const result = await runSync(id);
      return { id, result };
    } catch {
      // The connection is saved; the first sync can be retried (Plaid may still be gathering history).
      return { id, result: null };
    }
  });

  app.get('/api/connections', async (req) => {
    const conns = await db.query<{ id: string; institution_name: string | null; environment: string; status: string; last_error: string | null; last_synced_at: Date | null; created_at: Date }>(
      'SELECT id, institution_name, environment, status, last_error, last_synced_at, created_at FROM bank_connections WHERE household_id = $1 ORDER BY created_at', [hid(req)]);
    const accounts = await db.query<{ id: string; connection_id: string | null; name: string; type: string; subtype: string | null; mask: string | null; balance_cents: number; available_cents: number | null; institution: string | null; updated_at: Date; hidden: boolean }>(
      'SELECT id, connection_id, name, type, subtype, mask, balance_cents, available_cents, institution, updated_at, hidden FROM accounts WHERE household_id = $1 ORDER BY type, name', [hid(req)]);
    const shape = (a: (typeof accounts)[number]) => ({
      id: a.id, name: a.name, type: a.type, subtype: a.subtype, mask: a.mask, balance: a.balance_cents, available: a.available_cents,
      institution: a.institution, updatedAt: a.updated_at, hidden: a.hidden,
    });
    return {
      configured: !!bank,
      keyReady: !!process.env.HEARTH_ENCRYPTION_KEY || process.env.NODE_ENV !== 'production',
      environment: bank?.environment ?? null,
      connections: conns.map((c) => ({
        id: c.id, institution: c.institution_name, environment: c.environment, status: c.status, lastError: c.last_error,
        lastSyncedAt: c.last_synced_at, createdAt: c.created_at, accounts: accounts.filter((a) => a.connection_id === c.id).map(shape),
      })),
      manualAccounts: accounts.filter((a) => !a.connection_id).map(shape),
    };
  });

  app.post('/api/connections/:id/sync', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const conn = await ownConnection(req, id);
    const b = need();
    if (process.env.PLAID_ALLOW_REFRESH === 'true') {
      // On-demand refresh asks Kemba for brand-new activity; Plaid bills it separately, so it's opt-in.
      await b.refresh(decrypt(conn.access_token_enc)).catch(() => {});
      await db.query('UPDATE bank_connections SET last_refresh_requested_at = now() WHERE id = $1', [id]);
    }
    try {
      return { ok: true, result: await runSync(id) };
    } catch (e) {
      throw new HttpError(502, `Sync didn't finish: ${(e as { response?: { data?: { error_message?: string } } }).response?.data?.error_message ?? (e as Error).message}`);
    }
  });

  app.delete('/api/connections/:id', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const conn = await ownConnection(req, id);
    if (bank) await bank.removeItem(decrypt(conn.access_token_enc)).catch(() => {});
    // Keep the history: transactions stay, unlinked from the removed accounts.
    await db.query('UPDATE transactions SET account_id = NULL WHERE account_id IN (SELECT id FROM accounts WHERE connection_id = $1)', [id]);
    await db.query('DELETE FROM bank_connections WHERE id = $1', [id]);
    return { ok: true };
  });

  app.patch('/api/accounts/:id', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const b = z.object({ hidden: z.boolean() }).parse(req.body);
    const r = await db.query('UPDATE accounts SET hidden = $1 WHERE id = $2 AND household_id = $3 RETURNING id', [b.hidden, id, hid(req)]);
    if (!r.length) throw notFound();
    return { ok: true };
  });

  // Plaid's webhook. No session cookie here: authenticity comes from the signed Plaid-Verification header,
  // checked against the exact bytes received, so this scope keeps the raw body.
  await app.register(async (scope) => {
    scope.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
      (req as FastifyRequest & { rawBody?: string }).rawBody = body as string;
      try { done(null, JSON.parse(body as string)); } catch (e) { done(e as Error, undefined); }
    });
    scope.post('/api/plaid/webhook', async (req, reply) => {
      if (!bank) return reply.status(503).send({ error: 'Not configured' });
      const raw = (req as FastifyRequest & { rawBody?: string }).rawBody ?? '';
      const jwt = req.headers['plaid-verification'];
      if (!(await bank.verifyWebhook(raw, typeof jwt === 'string' ? jwt : undefined))) return reply.status(401).send({ error: 'Bad signature' });
      const w = z.object({ webhook_type: z.string(), webhook_code: z.string(), item_id: z.string().optional(), error: z.any().optional() }).passthrough().parse(req.body);
      const conn = w.item_id ? (await db.query<{ id: string }>('SELECT id FROM bank_connections WHERE item_id = $1', [w.item_id]))[0] : undefined;
      if (!conn) return { ok: true };
      if (w.webhook_type === 'TRANSACTIONS' && ['SYNC_UPDATES_AVAILABLE', 'DEFAULT_UPDATE', 'INITIAL_UPDATE', 'HISTORICAL_UPDATE'].includes(w.webhook_code)) {
        syncSoon(conn.id);
      } else if (w.webhook_type === 'ITEM') {
        const status = w.webhook_code === 'ERROR' && w.error?.error_code === 'ITEM_LOGIN_REQUIRED' ? 'login_required'
          : w.webhook_code === 'PENDING_EXPIRATION' || w.webhook_code === 'PENDING_DISCONNECT' ? 'login_required'
          : w.webhook_code === 'ERROR' ? 'error'
          : w.webhook_code === 'LOGIN_REPAIRED' ? 'ok' : null;
        if (status) await db.query('UPDATE bank_connections SET status = $1, last_error = $2 WHERE id = $3', [status, w.error?.error_message ?? null, conn.id]);
      }
      return { ok: true };
    });
  });
}
