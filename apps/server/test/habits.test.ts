import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import type { Leaf, PayeeAnswer, PayeeClassifier, PayeeQuestion } from '../src/agent';
import { newId } from '../src/auth';
import { migrate, openDb, type Db } from '../src/db';
import { seedHousehold } from '../src/seed';

/** A pretend Claude that recognizes nothing on its own but can "look up" one payee, and suggests tags. */
class FakeClaude implements PayeeClassifier {
  asked: string[][] = [];
  researched: string[][] = [];
  sawCategories: string[] = [];
  async classify(payees: PayeeQuestion[], leaves: Leaf[]) {
    this.asked.push(payees.map((p) => p.key));
    this.sawCategories = leaves.map((l) => l.path);
    return new Map(payees.map((p): [string, PayeeAnswer] => [p.key, { categoryId: null, confidence: 0 }]));
  }
  async research(payees: PayeeQuestion[], leaves: Leaf[]) {
    this.researched.push(payees.map((p) => p.key));
    const lunch = leaves.find((l) => l.path.endsWith('Student lunch accounts'))!;
    return new Map(payees.map((p): [string, PayeeAnswer] => [p.key, p.key === 'mealpayplusworth'
      ? { categoryId: lunch.id, confidence: 0.92, about: 'MealPay Plus: school lunch account payments' }
      : { categoryId: null, confidence: 0, about: null }]));
  }
  async suggestTag(t: { merchant: string }) { return t.merchant.includes('Auto') ? 'Car Repair' : 'One-off'; }
}

let db: Db;
let app: FastifyInstance;
let hid = '';
let cookie = '';
const claude = new FakeClaude();
const today = new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10);
const api = async (method: string, url: string, payload?: unknown) => {
  const res = await app.inject({ method: method as 'GET', url, payload: payload as object, headers: { cookie } });
  return { status: res.statusCode, body: res.json() };
};
const bankTxn = async (merchant: string, dollars: number, bankCategory: string | null, date = daysAgo(2)) => {
  const id = newId();
  await db.query(`INSERT INTO transactions (id, household_id, external_id, date, amount_cents, merchant, raw_name, bank_category, source)
    VALUES ($1,$2,$3,$4,$5,$6,$6,$7,'bank')`, [id, hid, `ext-${id}`, date, Math.round(dollars * 100), merchant, bankCategory]);
  return id;
};
const row = async (id: string) => (await db.query<{ category: string | null; suggestion: string | null; needs_review: boolean; tag: string | null; tag_source: string | null }>(
  `SELECT c.name AS category, s.name AS suggestion, t.needs_review, t.tag, t.tag_source FROM transactions t
   LEFT JOIN categories c ON c.id = t.category_id LEFT JOIN categories s ON s.id = t.suggested_category_id WHERE t.id = $1`, [id]))[0]!;
const cat = async (name: string) => (await db.query<{ id: string }>('SELECT id FROM categories WHERE name = $1', [name]))[0]!.id;

beforeAll(async () => {
  db = await openDb({ memory: true });
  await migrate(db);
  await seedHousehold(db, { devPassword: 'test-password-123' });
  hid = (await db.query<{ id: string }>('SELECT id FROM households'))[0]!.id;
  app = await buildApp(db, { classifier: claude });
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'jason@hearth.local', password: 'test-password-123' } });
  cookie = String(res.headers['set-cookie']).split(';')[0]!;
});
afterAll(async () => { await app.close(); await db.close(); });

describe('amounts', () => {
  it('reads $40 at a gas station as fuel and $4.50 as a snack to check', async () => {
    const gas = await bankTxn('Speedway', -40, 'TRANSPORTATION_GAS');
    const snack = await bankTxn('Speedway', -4.5, 'TRANSPORTATION_GAS');
    await api('POST', '/api/agent/run');
    expect(await row(gas)).toMatchObject({ category: 'Fuel' });
    expect(await row(snack)).toMatchObject({ category: null, needs_review: true, suggestion: 'Coffee & snacks' });
  });

  it("memory doesn't stretch to amounts it hasn't seen, and learns both habits once taught", async () => {
    for (const d of [10, 20]) await api('PATCH', `/api/transactions/${await bankTxn('Sheetz', -45, null, daysAgo(d))}`, { categoryId: await cat('Fuel') });
    const small = await bankTxn('Sheetz', -3.99, null);
    await api('POST', '/api/agent/run');
    expect((await row(small)).category).toBeNull();
    await api('PATCH', `/api/transactions/${small}`, { categoryId: await cat('Coffee & snacks') });
    const next = [await bankTxn('Sheetz', -5.25, null, today), await bankTxn('Sheetz', -52, null, today)];
    await api('POST', '/api/agent/run');
    expect((await row(next[0]!)).category).toBe('Coffee & snacks');
    expect((await row(next[1]!)).category).toBe('Fuel');
  });
});

describe('looking up unknown vendors', () => {
  it('researches a payee Claude could not place, once, and remembers what it is', async () => {
    const id = await bankTxn('Mealpayplusworth', -75, null, daysAgo(12));
    await api('POST', '/api/agent/run');
    expect(claude.researched.flat()).toContain('mealpayplusworth');
    expect((await row(id)).category).toBe('Student lunch accounts');
    const month = (await db.query<{ m: string }>("SELECT COALESCE(budget_month, to_char(date, 'YYYY-MM')) AS m FROM transactions WHERE id = $1", [id]))[0]!.m;
    const txns = (await api('GET', `/api/transactions?month=${month}`)).body as { merchant: string; about: string | null }[];
    expect(txns.find((t) => t.merchant === 'Mealpayplusworth')?.about).toMatch(/school lunch/);
    const before = claude.researched.flat().length;
    await bankTxn('Mealpayplusworth', -60, null);
    await api('POST', '/api/agent/run');
    expect(claude.researched.flat().length).toBe(before);
  });
});

describe('Miscellaneous', () => {
  it('exists, and is never chosen automatically', async () => {
    expect(await cat('Miscellaneous')).toBeTruthy();
    expect(claude.sawCategories.some((p) => /Miscellaneous/.test(p))).toBe(false);
  });

  it('suggests a tag when something is put there, and lets you change it', async () => {
    const id = await bankTxn('Midas Auto Service', -389.12, null);
    const r = await api('PATCH', `/api/transactions/${id}`, { categoryId: await cat('Miscellaneous') });
    expect(r.body.tag).toBe('Car Repair');
    expect(await row(id)).toMatchObject({ category: 'Miscellaneous', tag: 'Car Repair', tag_source: 'ai' });
    await api('PATCH', `/api/transactions/${id}`, { tag: 'Brakes' });
    expect(await row(id)).toMatchObject({ tag: 'Brakes', tag_source: 'you' });
  });

  it("one-offs don't teach memory: the next purchase from that payee isn't filed in Miscellaneous", async () => {
    const id = await bankTxn('Midas Auto Service', -45, null);
    await api('POST', '/api/agent/run');
    expect((await row(id)).category).not.toBe('Miscellaneous');
  });
});
