import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { addDays } from '@hearth/core';
import { buildApp } from '../src/app';
import { ClaudeClassifier, flowOf, leavesFor, type Leaf, type PayeeAnswer, type PayeeClassifier, type PayeeQuestion } from '../src/agent';
import { newId } from '../src/auth';
import { migrate, openDb, type Db } from '../src/db';
import { seedHousehold } from '../src/seed';
import { householdToday } from '../src/time';

/** Stands in for Claude: answers from a fixed table and records what it was asked. */
class FakeClaude implements PayeeClassifier {
  asked: string[] = [];
  constructor(private table: Record<string, [string, number]>) {}
  async classify(payees: PayeeQuestion[], leaves: Leaf[]) {
    const out = new Map<string, PayeeAnswer>();
    for (const p of payees) {
      this.asked.push(p.key);
      const hit = this.table[p.key];
      const leaf = hit && leaves.find((l) => l.path.endsWith(hit[0]));
      out.set(p.key, leaf ? { categoryId: leaf.id, confidence: hit[1] } : { categoryId: null, confidence: 0 });
    }
    return out;
  }
}

let db: Db;
let app: FastifyInstance;
let hid = '';
let cookie = '';
const today = householdToday();
const daysAgo = (n: number) => addDays(today, -n);
const claude = new FakeClaude({ zyxcorp: ['Music gear', 0.93], mysteryllc: ['Gifts & birthdays', 0.55] });

const api = async (method: string, url: string, payload?: unknown) => {
  const res = await app.inject({ method: method as 'GET', url, payload: payload as object, headers: { cookie } });
  return { status: res.statusCode, body: res.json() };
};
const bankTxn = async (merchant: string, dollars: number, bankCategory: string | null, date = daysAgo(3)) => {
  const id = newId();
  await db.query(
    `INSERT INTO transactions (id, household_id, external_id, date, amount_cents, merchant, raw_name, bank_category, source, flow)
     VALUES ($1,$2,$3,$4,$5,$6,$6,$7,'bank',$8)`,
    [id, hid, `ext-${id}`, date, Math.round(dollars * 100), merchant, bankCategory, flowOf(bankCategory, Math.round(dollars * 100))]);
  return id;
};
const row = async (id: string) => (await db.query<{ category: string | null; source: string; needs_review: boolean; suggestion: string | null; flow: string }>(
  `SELECT c.name AS category, t.source, t.needs_review, s.name AS suggestion, t.flow FROM transactions t
   LEFT JOIN categories c ON c.id = t.category_id LEFT JOIN categories s ON s.id = t.suggested_category_id WHERE t.id = $1`, [id]))[0]!;
const leafId = async (name: string) => (await leavesFor(db, hid)).find((l) => l.path.endsWith(name))!.id;

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

describe('flow', () => {
  it('keeps transfers and paychecks out of spending', () => {
    expect(flowOf('TRANSFER_OUT_ACCOUNT_TRANSFER', -50000)).toBe('transfer');
    expect(flowOf('INCOME_WAGES', 219800)).toBe('income');
    expect(flowOf('FOOD_AND_DRINK_GROCERIES', -8000)).toBe('spend');
  });
});

describe('categorization agent', () => {
  const ids: Record<string, string> = {};

  it('sorts with Plaid categories it can trust, asks Claude about new payees, and queues the unsure ones', async () => {
    ids.kroger = await bankTxn('Kroger', -112.4, 'FOOD_AND_DRINK_GROCERIES');
    ids.speedway = await bankTxn('Speedway', -48.1, 'TRANSPORTATION_GAS');
    ids.target = await bankTxn('Target', -63.2, 'GENERAL_MERCHANDISE_SUPERSTORES');
    ids.zyx = await bankTxn('ZYXCORP', -129, null);
    ids.mystery = await bankTxn('Mystery LLC', -40, null);
    ids.transfer = await bankTxn('Online Transfer to Savings', -500, 'TRANSFER_OUT_ACCOUNT_TRANSFER');
    ids.pay = await bankTxn('ACME PAYROLL', 2198, 'INCOME_WAGES');
    ids.old = await bankTxn('Old Shop', -20, null, daysAgo(200));

    const r = (await api('POST', '/api/agent/run')).body;
    expect(r).toMatchObject({ bank: 2, claude: 1 });

    expect(await row(ids.kroger)).toMatchObject({ category: 'Groceries', source: 'bank', needs_review: false });
    expect(await row(ids.speedway)).toMatchObject({ category: 'Fuel', source: 'bank' });
    expect(await row(ids.zyx)).toMatchObject({ category: 'Music gear', source: 'claude' });
    // Superstores sell everything: a person decides, with a guess ready.
    expect(await row(ids.target)).toMatchObject({ category: null, needs_review: true, suggestion: 'Household supplies' });
    expect(await row(ids.mystery)).toMatchObject({ category: null, needs_review: true, suggestion: 'Gifts & birthdays' });
    // Transfers, pay and old history never land in the review list.
    expect(await row(ids.transfer)).toMatchObject({ flow: 'transfer', needs_review: false });
    expect(await row(ids.pay)).toMatchObject({ flow: 'income', needs_review: false });
    expect(await row(ids.old)).toMatchObject({ needs_review: false });

    const review = (await api('GET', '/api/review')).body;
    expect(review.items.map((i: { merchant: string }) => i.merchant).sort()).toEqual(['Mystery LLC', 'Old Shop', 'Target'].filter((m) => m !== 'Old Shop'));
  });

  it("remembers Claude's answers instead of asking again", async () => {
    const before = claude.asked.length;
    await bankTxn('ZYXCORP', -15, null);
    await api('POST', '/api/agent/run');
    expect(claude.asked.length).toBe(before);
  });

  it('learns from a correction and sorts the same payee everywhere', async () => {
    const t2 = await bankTxn('Target', -18.5, 'GENERAL_MERCHANDISE_SUPERSTORES', daysAgo(10));
    await api('POST', '/api/agent/run');
    const r = await api('PATCH', `/api/transactions/${ids.target}`, { categoryId: await leafId('Household supplies') });
    expect(r.body.alsoSorted).toBe(1);
    expect(await row(t2)).toMatchObject({ category: 'Household supplies', needs_review: false });
    // A new store number is still Target.
    const t3 = await bankTxn('TARGET #1873', -22, 'GENERAL_MERCHANDISE_SUPERSTORES');
    await api('POST', '/api/agent/run');
    expect(await row(t3)).toMatchObject({ category: 'Household supplies' });
  });

  it('uses the learned model for a payee whose name varies', async () => {
    for (const d of [20, 40, 60]) {
      const id = await bankTxn(`Great Clips ${d}`, -24, 'PERSONAL_CARE_OTHER', daysAgo(d));
      await api('PATCH', `/api/transactions/${id}`, { categoryId: await leafId('Haircuts') });
    }
    const t = await bankTxn('GREAT CLIPS OF OHIO', -26, 'PERSONAL_CARE_OTHER');
    await api('POST', '/api/agent/run');
    expect(await row(t)).toMatchObject({ category: 'Haircuts', source: 'agent' });
  });

  it('accepts suggestions in bulk', async () => {
    const r = await api('POST', '/api/review/accept', { ids: [ids.mystery] });
    expect(r.body.accepted).toBe(1);
    expect(await row(ids.mystery!)).toMatchObject({ category: 'Gifts & birthdays', source: 'you', needs_review: false });
  });

  it('marking a payee as a transfer applies to its other and future transactions', async () => {
    const a = await bankTxn('Venmo', -60, null);
    const b = await bankTxn('Venmo', -25, null, daysAgo(5));
    await api('POST', '/api/agent/run');
    expect((await row(a)).needs_review).toBe(true);
    await api('PATCH', `/api/transactions/${a}`, { flow: 'transfer' });
    expect(await row(b)).toMatchObject({ flow: 'transfer', needs_review: false });
    const c = await bankTxn('VENMO', -10, null);
    await api('POST', '/api/agent/run');
    expect(await row(c)).toMatchObject({ flow: 'transfer', needs_review: false });
  });

  it('keeps going when Claude is unavailable', async () => {
    const broken = new ClaudeClassifier('key', 'claude-haiku-5-5', (async () => new Response('overloaded', { status: 529 })) as typeof fetch);
    const a2 = await buildApp(db, { classifier: broken });
    await bankTxn('Brand New Payee', -33, null);
    const res = await a2.inject({ method: 'POST', url: '/api/agent/run', headers: { cookie } });
    expect(res.json().claudeError).toMatch(/529/);
    expect(res.json().review).toBeGreaterThan(0);
    await a2.close();
  });
});

describe('Claude request', () => {
  it('sends payees and categories with a forced tool call, and ignores ids it made up', async () => {
    let sent: { model: string; tool_choice: unknown; messages: { content: string }[] } | undefined;
    const fake = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ content: [{ type: 'tool_use', input: { results: [{ key: 'kroger', category_id: 'cat-g', confidence: 0.9 }, { key: 'aldi', category_id: 'invented', confidence: 0.99 }] } }] }));
    }) as unknown as typeof fetch;
    const c = new ClaudeClassifier('key', 'claude-haiku-5-5', fake);
    const out = await c.classify(
      [{ key: 'kroger', merchant: 'Kroger', amounts: [-5000], bankCategory: null }, { key: 'aldi', merchant: 'Aldi', amounts: [-3000], bankCategory: null }],
      [{ id: 'cat-g', path: 'Food › Groceries', kind: 'everyday' }]);
    expect(sent?.model).toBe('claude-haiku-5-5');
    expect(sent?.tool_choice).toEqual({ type: 'tool', name: 'assign_categories' });
    expect(sent?.messages[0]!.content).not.toMatch(/balance|account/i);
    expect(out.get('kroger')).toEqual({ categoryId: 'cat-g', confidence: 0.9 });
    expect(out.get('aldi')).toEqual({ categoryId: null, confidence: 0 });
  });
});

describe('budget suggestions', () => {
  it('waits for about a month of history', async () => {
    const db2 = await openDb({ memory: true });
    await migrate(db2);
    await seedHousehold(db2, { devPassword: 'test-password-123' });
    const a2 = await buildApp(db2);
    const login = await a2.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'jason@hearth.local', password: 'test-password-123' } });
    const c2 = String(login.headers['set-cookie']).split(';')[0]!;
    const h2 = (await db2.query<{ id: string }>('SELECT id FROM households'))[0]!.id;
    await db2.query("INSERT INTO transactions (id, household_id, external_id, date, amount_cents, merchant) VALUES ('x', $1, 'e', $2, -1000, 'Kroger')", [h2, daysAgo(10)]);
    const r = await a2.inject({ method: 'GET', url: '/api/budget/suggestions?month=2026-10', headers: { cookie: c2 } });
    expect(r.json()).toMatchObject({ ready: false });
    await a2.close(); await db2.close();
  });

  it('averages 90 days of everyday spending into monthly amounts, rounded up to $5', async () => {
    const g = await leafId('Groceries');
    // $3,000 of groceries over the 90-day window → about $1,014.67 a month → $1,015.
    for (const d of [5, 35, 65]) {
      const id = await bankTxn('Kroger', -1000, 'FOOD_AND_DRINK_GROCERIES', daysAgo(d));
      await db.query('UPDATE transactions SET category_id = $1 WHERE id = $2', [g, id]);
    }
    await db.query("DELETE FROM transactions WHERE category_id = $1 AND amount_cents <> -100000", [g]);
    await bankTxn('Way back', -10, null, daysAgo(120));
    const s = (await api('GET', '/api/budget/suggestions?month=2026-10')).body;
    expect(s).toMatchObject({ ready: true, days: 90 });
    const groceries = s.items.find((i: { path: string }) => i.path.endsWith('Groceries'));
    expect(groceries).toMatchObject({ current: 110000, monthly: 101467, suggested: 101500, count: 3 });
    expect(s.items.every((i: { path: string }) => !/AEP|Rent|Emergency/.test(i.path))).toBe(true);

    const apply = await api('POST', '/api/budget/apply', { month: '2026-10', items: [{ categoryId: g, amount: 101500 }] });
    expect(apply.status).toBe(200);
    const budget = (await api('GET', '/api/budget?month=2026-10')).body;
    expect(budget.leftToAssign).toBe(1241 + 8500);
  });
});
