import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { Assistant, TOOLS, runTool } from '../src/assistant';
import { migrate, openDb, type Db } from '../src/db';
import { seedHousehold } from '../src/seed';

let db: Db;
let app: FastifyInstance;
let hid = '';
let cookie = '';
const sent: { tools: unknown[]; messages: { role: string; content: unknown }[]; system: string }[] = [];

/** Pretend Claude: first asks for the paycheck plan, then answers using what the tool returned. */
const fakeClaude = (async (_url: string, init: RequestInit) => {
  const body = JSON.parse(String(init.body));
  sent.push(body);
  const last = body.messages[body.messages.length - 1];
  if (Array.isArray(last.content) && last.content[0]?.type === 'tool_result') {
    const plan = JSON.parse(last.content[0].content);
    const h = plan.halves[0];
    return new Response(JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: `${h.step2.adds_check} joins ${h.step1.check}; together they cover to ${h.step2.until}.` }] }));
  }
  return new Response(JSON.stringify({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'get_paycheck_plan', input: { month: '2026-11' } }] }));
}) as unknown as typeof fetch;

beforeAll(async () => {
  db = await openDb({ memory: true });
  await migrate(db);
  await seedHousehold(db, { devPassword: 'test-password-123' });
  hid = (await db.query<{ id: string }>('SELECT id FROM households'))[0]!.id;
  app = await buildApp(db, { assistant: new Assistant('key', 'claude-haiku-5-5', fakeClaude) });
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'jason@hearth.local', password: 'test-password-123' } });
  cookie = String(res.headers['set-cookie']).split(';')[0]!;
});
afterAll(async () => { await app.close(); await db.close(); });

describe('tools', () => {
  it('every tool runs against real data and returns dollars', async () => {
    for (const t of TOOLS) {
      const input = t.name === 'spending_by' ? { from: '2026-09', to: '2026-11', group: 'category' } : { month: '2026-11' };
      const out = await runTool(db, hid, t.name, input);
      expect(out, t.name).toBeTruthy();
    }
    const budget = (await runTool(db, hid, 'get_budget', { month: '2026-11' })) as { take_home: number };
    expect(budget.take_home).toBe(9716);
    const sim = (await runTool(db, hid, 'simulate_payoff', { extra_monthly: 1000 })) as { debt_free: string; compared_to_current_plan: { debt_free: string } };
    expect(sim.debt_free < '2031-01').toBe(true);
  });
});

describe('asking', () => {
  it('answers using a tool, and keeps the conversation', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/assistant/ask', payload: { message: 'Which check pays November rent?' }, headers: { cookie } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ answer: 'Jason 2026-10-30 joins Renee 2026-10-23; together they cover to 2026-11-10.', tools: ['get_paycheck_plan'] });
    expect(sent[0]!.system).toContain('Jason');
    const conv = (await app.inject({ method: 'GET', url: `/api/assistant/${r.json().conversationId}`, headers: { cookie } })).json();
    expect(conv.messages.map((m: { role: string }) => m.role)).toEqual(['user', 'assistant']);
    const list = (await app.inject({ method: 'GET', url: '/api/assistant', headers: { cookie } })).json();
    expect(list).toMatchObject({ enabled: true, conversations: [{ title: 'Which check pays November rent?', who: 'Jason' }] });

    // A follow-up carries the earlier turns.
    await app.inject({ method: 'POST', url: '/api/assistant/ask', payload: { conversationId: r.json().conversationId, message: 'And December?' }, headers: { cookie } });
    const follow = sent.find((s, i) => i > 1 && s.messages[0]?.content === 'Which check pays November rent?');
    expect(follow?.messages.length).toBeGreaterThanOrEqual(3);
  });

  it('says how to turn it on when there is no API key', async () => {
    const bare = await buildApp(db);
    const r = await bare.inject({ method: 'POST', url: '/api/assistant/ask', payload: { message: 'hi' }, headers: { cookie } });
    expect(r.statusCode).toBe(503);
    await bare.close();
  });
});
