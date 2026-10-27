import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import type { BankAccount, BankProvider, BankTxn, SyncPage } from '../src/bank';
import { migrate, openDb, type Db } from '../src/db';
import { seedHousehold } from '../src/seed';
import { decrypt, encrypt } from '../src/crypto';

/** A pretend Kemba: tests queue up pages of transactions and see exactly what Hearth asks for. */
class FakeBank implements BankProvider {
  readonly environment = 'fake' as const;
  accounts: BankAccount[] = [
    { externalId: 'acc-chk', name: 'Share Draft Checking', mask: '1234', type: 'depository', subtype: 'checking', current: 412_345, available: 400_000, limit: null },
    { externalId: 'acc-sav', name: 'Primary Savings', mask: '9876', type: 'depository', subtype: 'savings', current: 1_000_000, available: 1_000_000, limit: null },
  ];
  pages: SyncPage[] = [];
  cursors: (string | null)[] = [];
  removedItems: string[] = [];
  async createLinkToken({ accessToken }: { userId: string; accessToken?: string }) { return accessToken ? `link-update-${accessToken}` : 'link-sandbox-123'; }
  async exchangePublicToken(publicToken: string) { return { accessToken: `access-${publicToken}`, itemId: `item-${publicToken}` }; }
  async getAccounts() { return this.accounts; }
  async syncTransactions(_t: string, cursor: string | null) {
    this.cursors.push(cursor);
    return this.pages.shift() ?? { added: [], modified: [], removed: [], nextCursor: cursor ?? 'c0', hasMore: false };
  }
  async refresh() {}
  async removeItem(token: string) { this.removedItems.push(token); }
  async verifyWebhook(_raw: string, jwt: string | undefined) { return jwt === 'good-signature'; }
}

const txn = (id: string, date: string, dollars: number, name: string, extra: Partial<BankTxn> = {}): BankTxn => ({
  externalId: id, accountExternalId: 'acc-chk', date, authorizedDate: date, amount: Math.round(dollars * 100), name, merchantName: name,
  pending: false, pendingExternalId: null, category: null, ...extra,
});

let db: Db;
let app: FastifyInstance;
const bank = new FakeBank();
let cookie = '';
const api = async (method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) => {
  const res = await app.inject({ method: method as 'GET', url, payload: payload as object, headers: { cookie, ...headers } });
  return { status: res.statusCode, body: res.json() };
};
const txns = async () => (await api('GET', '/api/transactions?month=2026-10')).body as { merchant: string; category_name: string | null; pending: boolean; amount_cents: number; source: string }[];
let connId = '';

beforeAll(async () => {
  db = await openDb({ memory: true });
  await migrate(db);
  await seedHousehold(db, { devPassword: 'test-password-123' });
  app = await buildApp(db, { bank, webhookDelayMs: 0 });
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'jason@hearth.local', password: 'test-password-123' } });
  cookie = String(res.headers['set-cookie']).split(';')[0]!;
});
afterAll(async () => { await app.close(); await db.close(); });

describe('token encryption', () => {
  it('round-trips and never stores the token in the clear', () => {
    const enc = encrypt('access-sandbox-abc', 'k1');
    expect(enc).not.toContain('access-sandbox-abc');
    expect(decrypt(enc, 'k1')).toBe('access-sandbox-abc');
    expect(() => decrypt(enc, 'wrong-key')).toThrow();
  });
});

describe('connecting Kemba', () => {
  it('hands out a link token and reports setup state', async () => {
    expect((await api('POST', '/api/plaid/link-token', {})).body).toMatchObject({ linkToken: 'link-sandbox-123', environment: 'fake' });
    const c = (await api('GET', '/api/connections')).body;
    expect(c).toMatchObject({ configured: true, connections: [] });
  });

  it('exchanges the token, stores it encrypted, and runs the first sync', async () => {
    // A manually entered checking balance should give way to the real one.
    await api('PUT', '/api/accounts/checking', { balance: 1000 });
    bank.pages.push(
      {
        added: [
          txn('t-aep', '2026-10-20', -287.14, 'AEP OHIO BILL PAY'),
          txn('t-aep-sep', '2026-09-19', -301.5, 'AEP OHIO BILL PAY'),
          txn('t-kroger-p', '2026-10-24', -84.12, 'KROGER #123', { pending: true }),
        ],
        modified: [], removed: [], nextCursor: 'c1', hasMore: true,
      },
      { added: [txn('t-pay', '2026-10-15', 2198, 'ACME CORP PAYROLL'), txn('t-gas', '2026-10-18', -58.2, 'SPEEDWAY GAS')], modified: [], removed: [], nextCursor: 'c2', hasMore: false },
    );
    const r = await api('POST', '/api/plaid/exchange', { publicToken: 'public-xyz', institution: { id: 'ins_kemba', name: 'Kemba Financial Credit Union' } });
    expect(r.status).toBe(200);
    expect(r.body.result).toMatchObject({ added: 5, removed: 0 });
    connId = r.body.id;
    const stored = (await db.query<{ access_token_enc: string; cursor: string }>('SELECT access_token_enc, cursor FROM bank_connections'))[0]!;
    expect(stored.access_token_enc).not.toContain('access-public-xyz');
    expect(decrypt(stored.access_token_enc)).toBe('access-public-xyz');
    expect(stored.cursor).toBe('c2');
    expect(bank.cursors).toEqual([null, 'c1']);
  });

  it('shows Kemba balances and replaces the hand-entered checking balance', async () => {
    const c = (await api('GET', '/api/connections')).body;
    expect(c.connections[0].accounts.map((a: { name: string; balance: number }) => [a.name, a.balance])).toEqual([
      ['Share Draft Checking', 412_345], ['Primary Savings', 1_000_000],
    ]);
    expect(c.manualAccounts).toEqual([]);
    const f = (await api('GET', '/api/calendar?month=2026-10')).body.forecast;
    expect(f.startBalance).toBe(412_345);
  });

  it('matches bills by brand and amount, but not a gas station to the gas bill', async () => {
    const list = await txns();
    const by = (m: string) => list.find((t) => t.merchant === m)!;
    expect(by('AEP OHIO BILL PAY').category_name).toBe('AEP');
    expect(by('AEP OHIO BILL PAY').source).toBe('rule');
    expect(by('SPEEDWAY GAS').category_name).toBeNull();
    expect(by('KROGER #123').pending).toBe(true);
  });

  it('learns a due date from two payments, leaving dates you set alone', async () => {
    const s = (await db.query<{ days: number[]; date_source: string; window_days: number }>("SELECT days, date_source, window_days FROM schedules WHERE name = 'AEP'"))[0]!;
    expect(s.date_source).toBe('learned');
    expect(s.days).toEqual([20]);
    expect(s.window_days).toBe(1);
  });

  it('remembers how you categorized a payee and carries it when a pending charge posts', async () => {
    const list = (await api('GET', '/api/transactions?month=2026-10')).body as { id: string; merchant: string }[];
    const kroger = list.find((t) => t.merchant === 'KROGER #123')!;
    const cats = (await api('GET', '/api/budget?month=2026-10')).body;
    const groceries = JSON.stringify(cats.tree).match(/"id":"([^"]+)","name":"Groceries"/)![1];
    await api('PATCH', `/api/transactions/${kroger.id}`, { categoryId: groceries });

    bank.pages.push({
      added: [
        txn('t-kroger', '2026-10-25', -84.12, 'KROGER #123', { pendingExternalId: 't-kroger-p' }),
        txn('t-kroger2', '2026-10-26', -40, 'Kroger #123'),
      ],
      modified: [], removed: ['t-kroger-p'], nextCursor: 'c3', hasMore: false,
    });
    const r = await api('POST', `/api/connections/${connId}/sync`);
    expect(r.body.result).toMatchObject({ added: 2, removed: 1 });
    const after = (await txns()).filter((t) => t.merchant.toLowerCase().startsWith('kroger'));
    expect(after).toHaveLength(2);
    expect(after.every((t) => t.category_name === 'Groceries' && !t.pending)).toBe(true);
  });
});

describe('Plaid webhook', () => {
  it('is reachable without a session but rejects a bad signature', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/plaid/webhook', payload: { webhook_type: 'TRANSACTIONS', webhook_code: 'SYNC_UPDATES_AVAILABLE', item_id: 'item-public-xyz' }, headers: { 'plaid-verification': 'forged' } });
    expect(res.statusCode).toBe(401);
  });

  it('syncs when Plaid says new transactions are ready', async () => {
    bank.pages.push({ added: [txn('t-splice', '2026-10-24', -32.99, 'SPLICE.COM')], modified: [], removed: [], nextCursor: 'c4', hasMore: false });
    const res = await app.inject({ method: 'POST', url: '/api/plaid/webhook', payload: { webhook_type: 'TRANSACTIONS', webhook_code: 'SYNC_UPDATES_AVAILABLE', item_id: 'item-public-xyz' }, headers: { 'plaid-verification': 'good-signature' } });
    expect(res.statusCode).toBe(200);
    for (let i = 0; i < 50 && !(await txns()).some((t) => t.merchant === 'SPLICE.COM'); i++) await new Promise((r) => setTimeout(r, 20));
    expect((await txns()).find((t) => t.merchant === 'SPLICE.COM')?.category_name).toBe('Splice');
  });

  it('flags a connection that needs Kemba sign-in again, and offers update mode', async () => {
    await app.inject({ method: 'POST', url: '/api/plaid/webhook', payload: { webhook_type: 'ITEM', webhook_code: 'ERROR', item_id: 'item-public-xyz', error: { error_code: 'ITEM_LOGIN_REQUIRED', error_message: 'the login details of this item have changed' } }, headers: { 'plaid-verification': 'good-signature' } });
    expect((await api('GET', '/api/connections')).body.connections[0].status).toBe('login_required');
    expect((await api('POST', '/api/plaid/link-token', { connectionId: connId })).body.linkToken).toBe('link-update-access-public-xyz');
  });
});

describe('disconnecting', () => {
  it('removes the item at Plaid but keeps transaction history', async () => {
    const before = (await txns()).length;
    expect((await api('DELETE', `/api/connections/${connId}`)).status).toBe(200);
    expect(bank.removedItems).toEqual(['access-public-xyz']);
    expect((await api('GET', '/api/connections')).body.connections).toEqual([]);
    expect((await txns()).length).toBe(before);
  });

  it('answers clearly when Plaid is not configured', async () => {
    const bare = await buildApp(db);
    const res = await bare.inject({ method: 'POST', url: '/api/plaid/link-token', payload: {}, headers: { cookie } });
    expect(res.statusCode).toBe(503);
    await bare.close();
  });
});

describe('Plaid errors', () => {
  it('shows Plaid\'s own message instead of a generic error', async () => {
    const failing = Object.create(bank) as FakeBank;
    failing.createLinkToken = async () => { throw Object.assign(new Error('Request failed with status code 400'), { response: { data: { error_type: 'INVALID_INPUT', error_code: 'INVALID_API_KEYS', error_message: 'invalid client_id or secret provided', display_message: null } } }); };
    const a = await buildApp(db, { bank: failing });
    const res = await a.inject({ method: 'POST', url: '/api/plaid/link-token', payload: {}, headers: { cookie } });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe('Plaid: invalid client_id or secret provided (INVALID_API_KEYS)');
    await a.close();
  });
});
