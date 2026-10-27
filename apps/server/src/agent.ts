import type { Db } from './db';
import { categorize, norm } from './sync';

/**
 * The categorization agent. For each uncategorized purchase it tries, in order:
 *   1. payee memory and bill matching (sync.ts `categorize`): what the household already decided;
 *   2. a small learned model trained on the household's own choices (naive Bayes over payee words,
 *      Plaid's category and a rough amount);
 *   3. Plaid's own category, mapped onto Hearth's categories where that mapping is dependable;
 *   4. Claude, once per new payee, when an API key is configured (answers are remembered per payee).
 * Anything still below 80% confidence waits in the review list with the best guess attached.
 */

export const CONFIDENT = 0.8;
export type Flow = 'spend' | 'income' | 'transfer';

export interface Leaf { id: string; path: string; kind: string | null }
export interface PayeeQuestion { key: string; merchant: string; amounts: number[]; bankCategory: string | null }
export interface PayeeAnswer { categoryId: string | null; confidence: number }
/** Something that can suggest categories for payees it hasn't seen (Claude in production, a fake in tests). */
export interface PayeeClassifier { classify(payees: PayeeQuestion[], leaves: Leaf[]): Promise<Map<string, PayeeAnswer>> }

/** Spending, income, or money moving between the household's own accounts, from Plaid's category. */
export function flowOf(bankCategory: string | null, amount: number): Flow {
  const c = bankCategory ?? '';
  if (c.startsWith('TRANSFER_IN') || c.startsWith('TRANSFER_OUT')) return 'transfer';
  if (c.startsWith('INCOME') && amount > 0) return 'income';
  return 'spend';
}

// ---------- learned model ----------

const NOISE = new Set(['pos', 'debit', 'credit', 'purchase', 'card', 'ach', 'www', 'com', 'inc', 'llc', 'the', 'and', 'pmt', 'payment', 'store',
  'online', 'recurring', 'visa', 'web', 'ppd', 'des', 'indn', 'co', 'usa', 'columbus', 'ohio', 'oh', 'sq', 'tst', 'paypal']);

export function features(merchant: string, rawName: string | null, bankCategory: string | null, amount: number): string[] {
  const words = new Set(`${merchant} ${rawName ?? ''}`.toLowerCase().replace(/[^a-z]+/g, ' ').split(' ').filter((w) => w.length >= 3 && !NOISE.has(w)));
  const f = [...words].map((w) => `w:${w}`);
  f.push(`m:${norm(merchant)}`);
  if (bankCategory) f.push(`b:${bankCategory}`);
  f.push(`a:${Math.floor(Math.log2(Math.abs(amount) / 100 + 1))}`);
  return f;
}

export class PayeeModel {
  private docs = new Map<string, number>();
  private counts = new Map<string, Map<string, number>>();
  private totals = new Map<string, number>();
  private vocab = new Set<string>();
  private n = 0;

  add(categoryId: string, f: string[]) {
    this.n++;
    this.docs.set(categoryId, (this.docs.get(categoryId) ?? 0) + 1);
    const m = this.counts.get(categoryId) ?? new Map<string, number>();
    for (const x of f) { m.set(x, (m.get(x) ?? 0) + 1); this.vocab.add(x); }
    this.counts.set(categoryId, m);
    this.totals.set(categoryId, (this.totals.get(categoryId) ?? 0) + f.length);
  }

  get size() { return this.n; }

  /**
   * Best category with its probability. Confidence only counts when the payee itself (or two of its
   * words, or its only word) has been seen in that category before; Plaid's category and the amount alone are not enough.
   */
  predict(f: string[]): { categoryId: string; confidence: number; evidence: boolean } | null {
    if (this.n < 3) return null;
    const cats = [...this.docs.keys()];
    const V = this.vocab.size + 1;
    const scores = cats.map((c) => {
      const m = this.counts.get(c)!;
      const tot = this.totals.get(c)!;
      let s = Math.log(this.docs.get(c)! / this.n);
      for (const x of f) s += Math.log(((m.get(x) ?? 0) + 0.5) / (tot + 0.5 * V));
      return s;
    });
    const max = Math.max(...scores);
    const exp = scores.map((s) => Math.exp(s - max));
    const sum = exp.reduce((a, b) => a + b, 0);
    let best = 0;
    for (let i = 1; i < cats.length; i++) if (exp[i]! > exp[best]!) best = i;
    const cat = cats[best]!;
    const m = this.counts.get(cat)!;
    const seenPayee = f.some((x) => x.startsWith('m:') && m.has(x));
    const seenWords = f.filter((x) => x.startsWith('w:') && m.has(x)).length;
    const words = f.filter((x) => x.startsWith('w:')).length;
    return { categoryId: cat, confidence: exp[best]! / sum, evidence: seenPayee || (words > 0 && seenWords >= Math.min(2, words)) };
  }
}

// ---------- Plaid category → Hearth category ----------

/** [Plaid category prefix, pattern for a Hearth category name, how dependable the mapping is]. First match wins. */
const BANK_MAP: [string, RegExp, number][] = [
  ['FOOD_AND_DRINK_GROCERIES', /grocer/i, 0.85],
  ['FOOD_AND_DRINK_COFFEE', /coffee/i, 0.85],
  ['FOOD_AND_DRINK_FAST_FOOD', /restaurant|takeout|dining/i, 0.8],
  ['FOOD_AND_DRINK_RESTAURANT', /restaurant|takeout|dining/i, 0.8],
  ['FOOD_AND_DRINK', /snack|coffee/i, 0.5],
  ['TRANSPORTATION_GAS', /fuel|gasoline/i, 0.9],
  ['GENERAL_SERVICES_AUTOMOTIVE', /car maint|auto/i, 0.85],
  ['TRANSPORTATION', /fuel/i, 0.4],
  ['PERSONAL_CARE_HAIR_AND_BEAUTY', /hair/i, 0.85],
  ['GENERAL_MERCHANDISE_CLOTHING_AND_ACCESSORIES', /cloth/i, 0.8],
  ['GENERAL_MERCHANDISE_PET_SUPPLIES', /pet/i, 0.85],
  ['MEDICAL_VETERINARY_SERVICES', /pet/i, 0.85],
  ['GENERAL_MERCHANDISE_GIFTS_AND_NOVELTIES', /gift/i, 0.8],
  ['GENERAL_MERCHANDISE', /household/i, 0.55],
  ['HOME_IMPROVEMENT', /household/i, 0.6],
  ['ENTERTAINMENT_VIDEO_GAMES', /games?\b/i, 0.8],
  ['ENTERTAINMENT_MUSIC_AND_AUDIO', /music/i, 0.6],
  ['ENTERTAINMENT', /outing/i, 0.5],
  ['GOVERNMENT_AND_NON_PROFIT_DONATIONS', /tithe|giving|donat/i, 0.8],
  ['GOVERNMENT_AND_NON_PROFIT_GOVERNMENT', /registration/i, 0.5],
];

export function fromBankCategory(bankCategory: string | null, leaves: Leaf[]): PayeeAnswer | null {
  if (!bankCategory) return null;
  for (const [prefix, re, conf] of BANK_MAP) {
    if (!bankCategory.startsWith(prefix)) continue;
    const leaf = leaves.find((l) => re.test(l.path.split(' › ').pop()!));
    return leaf ? { categoryId: leaf.id, confidence: conf } : null;
  }
  return null;
}

// ---------- Claude ----------

export class ClaudeClassifier implements PayeeClassifier {
  constructor(private apiKey: string, private model = 'claude-haiku-5-5', private fetchImpl: typeof fetch = fetch) {}

  async classify(payees: PayeeQuestion[], leaves: Leaf[]) {
    const out = new Map<string, PayeeAnswer>();
    const ids = new Set(leaves.map((l) => l.id));
    for (let i = 0; i < payees.length; i += 40) {
      const batch = payees.slice(i, i + 40);
      const res = await this.fetchImpl('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          max_tokens: 4096,
          system:
            'You sort bank transactions for a family budget in Columbus, Ohio. For each payee, choose the single best budget category id from the list, ' +
            'or null if none fits or the payee is too ambiguous to tell (for example a superstore that sells groceries and household goods). ' +
            'Confidence is your probability (0 to 1) that the household would agree. Be honest: use below 0.8 whenever a person would need to check.',
          tools: [{
            name: 'assign_categories',
            description: 'Record the category for each payee.',
            input_schema: {
              type: 'object',
              properties: {
                results: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: { key: { type: 'string' }, category_id: { type: ['string', 'null'] }, confidence: { type: 'number' } },
                    required: ['key', 'category_id', 'confidence'],
                  },
                },
              },
              required: ['results'],
            },
          }],
          tool_choice: { type: 'tool', name: 'assign_categories' },
          messages: [{
            role: 'user',
            content: JSON.stringify({
              categories: leaves.map((l) => ({ id: l.id, name: l.path })),
              payees: batch.map((p) => ({ key: p.key, payee: p.merchant, recent_amounts_usd: p.amounts.map((a) => Math.abs(a) / 100), bank_category: p.bankCategory })),
            }),
          }],
        }),
      });
      if (!res.ok) throw new Error(`Claude request failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
      const data = await res.json() as { content: { type: string; input?: { results?: { key: string; category_id: string | null; confidence: number }[] } }[] };
      const results = data.content.find((c) => c.type === 'tool_use')?.input?.results ?? [];
      for (const r of results) {
        if (!batch.some((p) => p.key === r.key)) continue;
        const cat = r.category_id && ids.has(r.category_id) ? r.category_id : null;
        out.set(r.key, { categoryId: cat, confidence: cat ? Math.max(0, Math.min(1, Number(r.confidence) || 0)) : 0 });
      }
    }
    return out;
  }
}

export function classifierFromEnv(env = process.env): PayeeClassifier | null {
  return env.ANTHROPIC_API_KEY ? new ClaudeClassifier(env.ANTHROPIC_API_KEY, env.HEARTH_AGENT_MODEL || undefined) : null;
}

// ---------- the run ----------

export async function leavesFor(db: Db, hid: string): Promise<Leaf[]> {
  const rows = await db.query<{ id: string; name: string; parent_id: string | null; kind: string | null }>(
    'SELECT id, name, parent_id, kind FROM categories WHERE household_id = $1 AND NOT archived', [hid]);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const hasKids = new Set(rows.map((r) => r.parent_id).filter(Boolean));
  const path = (r: (typeof rows)[number]): string => (r.parent_id && byId.get(r.parent_id) ? `${path(byId.get(r.parent_id)!)} › ${r.name}` : r.name);
  return rows.filter((r) => !hasKids.has(r.id)).map((r) => ({ id: r.id, path: path(r), kind: r.kind }));
}

export interface AgentResult { remembered: number; model: number; bank: number; claude: number; review: number; claudeError?: string }

interface Candidate { id: string; merchant: string; raw_name: string | null; bank_category: string | null; amount_cents: number; date: string }

export async function runAgent(db: Db, hid: string, opts: { classifier?: PayeeClassifier | null; today: string; windowDays?: number }): Promise<AgentResult> {
  const windowDays = opts.windowDays ?? 90;
  const since = new Date(Date.parse(opts.today + 'T12:00:00Z') - windowDays * 86400_000).toISOString().slice(0, 10);
  const res: AgentResult = { remembered: 0, model: 0, bank: 0, claude: 0, review: 0 };
  const leaves = await leavesFor(db, hid);
  const leafIds = new Set(leaves.map((l) => l.id));

  // Payees the household marked as transfers or income stay that way.
  const flowHints = await db.query<{ merchant_key: string; flow: string }>("SELECT merchant_key, flow FROM payee_hints WHERE household_id = $1 AND flow IS NOT NULL AND flow <> 'spend'", [hid]);
  for (const h of flowHints) {
    await db.query(
      `UPDATE transactions SET flow = $1, needs_review = FALSE, suggested_category_id = NULL
       WHERE household_id = $2 AND category_id IS NULL AND flow = 'spend' AND regexp_replace(lower(merchant), '[^a-z]', '', 'g') = $3`, [h.flow, hid, h.merchant_key]);
  }

  const load = () => db.query<Candidate>(
    `SELECT id, merchant, raw_name, bank_category, amount_cents, to_char(date, 'YYYY-MM-DD') AS date FROM transactions
     WHERE household_id = $1 AND category_id IS NULL AND flow = 'spend' ORDER BY date DESC`, [hid]);

  // 1. Memory and bills.
  const first = await load();
  res.remembered = await categorize(db, hid, first.map((t) => t.id));
  let todo = res.remembered ? await load() : first;
  if (!todo.length) return res;

  // 2. Learned model, trained on what people chose (and bill matches, which are exact).
  const model = new PayeeModel();
  const training = await db.query<{ category_id: string; merchant: string; raw_name: string | null; bank_category: string | null; amount_cents: number }>(
    `SELECT category_id, merchant, raw_name, bank_category, amount_cents FROM transactions
     WHERE household_id = $1 AND category_id IS NOT NULL AND flow = 'spend' AND source IN ('you', 'manual', 'rule')`, [hid]);
  for (const t of training) if (leafIds.has(t.category_id)) model.add(t.category_id, features(t.merchant, t.raw_name, t.bank_category, t.amount_cents));

  const best = new Map<string, PayeeAnswer>();
  const consider = (id: string, a: PayeeAnswer | null) => {
    if (!a?.categoryId) return;
    const cur = best.get(id);
    if (!cur || a.confidence > cur.confidence) best.set(id, a);
  };
  const assign = async (t: Candidate, a: PayeeAnswer, source: string) => {
    await db.query("UPDATE transactions SET category_id = $1, source = $2, confidence = $3, needs_review = FALSE, suggested_category_id = NULL WHERE id = $4",
      [a.categoryId, source, a.confidence, t.id]);
  };

  const left: Candidate[] = [];
  for (const t of todo) {
    const p = model.predict(features(t.merchant, t.raw_name, t.bank_category, t.amount_cents));
    if (p && p.evidence && p.confidence >= CONFIDENT) { await assign(t, p, 'agent'); res.model++; continue; }
    if (p) consider(t.id, { categoryId: p.categoryId, confidence: Math.min(p.confidence, p.evidence ? 1 : 0.5) });
    // 3. Plaid's category.
    const b = fromBankCategory(t.bank_category, leaves);
    if (b && b.confidence >= CONFIDENT) { await assign(t, b, 'bank'); res.bank++; continue; }
    consider(t.id, b);
    left.push(t);
  }
  todo = left;

  // 4. Claude: remembered answers first, then ask about new payees in the review window.
  const hints = new Map((await db.query<{ merchant_key: string; category_id: string | null; confidence: number | null }>(
    "SELECT merchant_key, category_id, confidence FROM payee_hints WHERE household_id = $1 AND source = 'claude'", [hid])).map((h) => [h.merchant_key, h]));
  if (opts.classifier) {
    const ask = new Map<string, PayeeQuestion>();
    for (const t of todo) {
      const key = norm(t.merchant);
      if (!key || hints.has(key) || t.date < since) continue;
      const q = ask.get(key) ?? { key, merchant: t.merchant, amounts: [], bankCategory: t.bank_category };
      if (q.amounts.length < 3) q.amounts.push(t.amount_cents);
      ask.set(key, q);
    }
    const questions = [...ask.values()].slice(0, 300);
    if (questions.length) {
      try {
        const answers = await opts.classifier.classify(questions, leaves);
        for (const q of questions) {
          const a = answers.get(q.key) ?? { categoryId: null, confidence: 0 };
          await db.query(
            `INSERT INTO payee_hints (household_id, merchant_key, category_id, confidence, source) VALUES ($1,$2,$3,$4,'claude')
             ON CONFLICT (household_id, merchant_key) DO UPDATE SET category_id = EXCLUDED.category_id, confidence = EXCLUDED.confidence, source = 'claude', updated_at = now()`,
            [hid, q.key, a.categoryId, a.confidence]);
          hints.set(q.key, { merchant_key: q.key, category_id: a.categoryId, confidence: a.confidence });
        }
      } catch (e) {
        res.claudeError = (e as Error).message;
      }
    }
  }
  for (const t of todo) {
    const h = hints.get(norm(t.merchant));
    const a = h?.category_id && leafIds.has(h.category_id) ? { categoryId: h.category_id, confidence: h.confidence ?? 0 } : null;
    if (a && a.confidence >= CONFIDENT) { await assign(t, a, 'claude'); res.claude++; continue; }
    consider(t.id, a);
    // 5. Recent ones a person should look at; older history just stays unsorted.
    if (t.date >= since) {
      const s = best.get(t.id);
      await db.query('UPDATE transactions SET needs_review = TRUE, suggested_category_id = $1, confidence = $2 WHERE id = $3', [s?.categoryId ?? null, s?.confidence ?? null, t.id]);
      res.review++;
    }
  }
  return res;
}
