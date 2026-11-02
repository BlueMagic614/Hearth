import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { newId } from '../src/auth';
import { splitAmount } from '../src/cash';
import { flowOf } from '../src/agent';
import { migrate, openDb, type Db } from '../src/db';
import { seedHousehold } from '../src/seed';

let db: Db;
let app: FastifyInstance;
let hid = '';
let cookie = '';
const M = '2026-11';
type Node = { name: string; children: Node[]; totalSpent: number };
const find = (ns: Node[], name: string): Node | undefined => { for (const n of ns) { if (n.name === name) return n; const f = find(n.children, name); if (f) return f; } return undefined; };
const api = async (method: string, url: string, payload?: unknown) => {
  const res = await app.inject({ method: method as 'GET', url, payload: payload as object, headers: { cookie } });
  return { status: res.statusCode, body: res.json() };
};
const cat = async (name: string) => (await db.query<{ id: string }>('SELECT id FROM categories WHERE name = $1', [name]))[0]!.id;
const withdrawal = async (dollars: number, date: string) => {
  const id = newId();
  await db.query(`INSERT INTO transactions (id, household_id, external_id, date, amount_cents, merchant, raw_name, bank_category, source, flow)
    VALUES ($1,$2,$3,$4,$5,'ATM WITHDRAWAL KEMBA','ATM WITHDRAWAL KEMBA','TRANSFER_OUT_WITHDRAWAL','bank','cash')`, [id, hid, `ext-${id}`, date, -dollars * 100]);
  return id;
};

beforeAll(async () => {
  db = await openDb({ memory: true });
  await migrate(db);
  await seedHousehold(db, { devPassword: 'test-password-123' });
  hid = (await db.query<{ id: string }>('SELECT id FROM households'))[0]!.id;
  app = await buildApp(db);
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'jason@hearth.local', password: 'test-password-123' } });
  cookie = String(res.headers['set-cookie']).split(';')[0]!;
  // Envelopes for the test: Groceries $1,100, Fuel $250, Date nights $100.
  for (const n of ['Groceries', 'Fuel', 'Date nights']) await api('PATCH', `/api/categories/${await cat(n)}`, { cash: true });
});
afterAll(async () => { await app.close(); await db.close(); });

describe('withdrawals', () => {
  it('recognizes ATM withdrawals as cash, not spending', () => {
    expect(flowOf('TRANSFER_OUT_WITHDRAWAL', -60000)).toBe('cash');
    expect(flowOf(null, -20000, 'ATM WITHDRAWAL 1234 MAIN ST')).toBe('cash');
    expect(flowOf('BANK_FEES_ATM_FEES', -300, 'ATM FEE')).toBe('spend');
  });

  it('splits in whole dollars, in proportion when short', () => {
    expect(splitAmount(60000, [{ categoryId: 'g', need: 110000 }, { categoryId: 'f', need: 25000 }, { categoryId: 'd', need: 10000 }]))
      .toEqual([{ categoryId: 'g', amount: 45500 }, { categoryId: 'f', amount: 10400 }, { categoryId: 'd', amount: 4100 }]);
    expect(splitAmount(150000, [{ categoryId: 'g', need: 110000 }, { categoryId: 'f', need: 25000 }]))
      .toEqual([{ categoryId: 'g', amount: 110000 }, { categoryId: 'f', amount: 25000 }, { categoryId: null, amount: 15000 }]);
  });

  it('fills envelopes from a withdrawal, which counts as spending in those categories', async () => {
    await withdrawal(800, '2026-11-02');
    await api('POST', '/api/agent/run');
    const cash = (await api('GET', `/api/cash?month=${M}`)).body;
    expect(cash.plannedCash).toBe(145000);
    expect(cash.withdrawals[0].fills.reduce((s: number, f: { amount: number }) => s + f.amount, 0)).toBe(80000);
    expect(cash.toFill).toBe(65000);
    const tree = (await api('GET', `/api/budget?month=${M}`)).body.tree as Node[];
    const filled = ['Groceries', 'Fuel', 'Date nights'].map((n) => find(tree, n)!.totalSpent);
    expect(filled.reduce((a, b) => a + b, 0)).toBe(80000);
  });

  it('lets you change the split, as long as it adds up', async () => {
    const id = (await api('GET', `/api/cash?month=${M}`)).body.withdrawals[0].id;
    const bad = await api('PUT', `/api/cash/withdrawals/${id}`, { parts: [{ categoryId: await cat('Groceries'), amount: 50000 }] });
    expect(bad.status).toBe(400);
    const ok = await api('PUT', `/api/cash/withdrawals/${id}`, { parts: [{ categoryId: await cat('Groceries'), amount: 60000 }, { categoryId: await cat('Fuel'), amount: 15000 }, { categoryId: await cat('Date nights'), amount: 5000 }] });
    expect(ok.status).toBe(200);
    expect(find((await api('GET', `/api/budget?month=${M}`)).body.tree, 'Groceries')!.totalSpent).toBe(60000);
  });

  it('plans the rest of the month\'s cash as a withdrawal in the forecast', async () => {
    await api('PUT', '/api/accounts/checking', { balance: 5000 });
    const f = (await api('GET', `/api/calendar?month=${M}`)).body.forecast;
    expect(f).toBeTruthy();
  });
});

describe('leftovers', () => {
  it('counts leftover cash back out of the envelopes into the Leftovers fund, and recommends where it goes', async () => {
    const r = await api('POST', '/api/cash/leftovers', { month: M, items: [{ categoryId: await cat('Groceries'), amount: 4000 }, { categoryId: await cat('Date nights'), amount: 2300 }] });
    expect(r.body.balance).toBe(6300);
    expect(find((await api('GET', `/api/budget?month=${M}`)).body.tree, 'Groceries')!.totalSpent).toBe(56000);
    const cash = (await api('GET', `/api/cash?month=${M}`)).body;
    expect(cash.leftovers.balance).toBe(6300);
    // Emergency fund has $0, so the $1,000 starter fund comes first.
    expect(cash.leftovers.best).toMatchObject({ destination: 'goal', targetName: 'Emergency fund' });
    expect(cash.leftovers.options.some((o: { destination: string; targetName: string }) => o.destination === 'loan' && o.targetName === 'Mohela')).toBe(true);
  });

  it('recounting replaces the earlier count', async () => {
    const r = await api('POST', '/api/cash/leftovers', { month: M, items: [{ categoryId: await cat('Groceries'), amount: 5000 }] });
    expect(r.body.balance).toBe(5000);
  });

  it('moves leftovers to a loan, lowering its balance so the payoff plan updates', async () => {
    const mohela = (await db.query<{ id: string; balance_cents: number }>("SELECT id, balance_cents FROM loans WHERE name = 'Mohela'"))[0]!;
    const r = await api('POST', '/api/cash/leftovers/move', { amount: 5000, destination: 'loan', targetId: mohela.id });
    expect(r.body).toMatchObject({ to: 'Mohela', balance: 0 });
    const after = (await db.query<{ balance_cents: number }>('SELECT balance_cents FROM loans WHERE id = $1', [mohela.id]))[0]!;
    expect(after.balance_cents).toBe(mohela.balance_cents - 5000);
    expect((await api('POST', '/api/cash/leftovers/move', { amount: 100, destination: 'checking' })).status).toBe(400);
  });
});
