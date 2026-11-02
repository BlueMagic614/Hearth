import type { Db } from './db';
import { assignBudgetMonths, categorize, linkBills, norm } from './sync';

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

export interface Leaf { id: string; path: string; kind: string | null; months?: number[] | null }
export interface PayeeQuestion { key: string; merchant: string; amounts: number[]; bankCategory: string | null }
/** about: a few words on what the business is, when Claude knows or looked it up ("MealPay: school lunch payments"). */
export interface PayeeAnswer { categoryId: string | null; confidence: number; about?: string | null }
/** Something that can suggest categories for payees it hasn't seen (Claude in production, a fake in tests). */
export interface PayeeClassifier {
  classify(payees: PayeeQuestion[], leaves: Leaf[]): Promise<Map<string, PayeeAnswer>>;
  /** Like classify, but allowed to search the web first, for payee names nobody recognizes. */
  research?(payees: PayeeQuestion[], leaves: Leaf[]): Promise<Map<string, PayeeAnswer>>;
  /** A short label for a one-off expense ("Car repair", "Birthday gift"). */
  suggestTag?(t: { merchant: string; amount: number; about?: string | null; date: string }): Promise<string | null>;
}

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

/** Under this, a gas-station purchase is a snack or drink rather than fuel (until the household's own amounts say otherwise). */
export const SMALL_STOP = 1500;

/** [Plaid category prefix, pattern for a Hearth category name, how dependable the mapping is]. First match wins. */
const BANK_MAP: [string, RegExp, number][] = [
  ['RENT_AND_UTILITIES_RENT', /^rent$/i, 0.9],
  ['RENT_AND_UTILITIES_TELEPHONE', /mobile|phone/i, 0.6],
  ['RENT_AND_UTILITIES_INTERNET_AND_CABLE', /internet/i, 0.6],
  ['MEDICAL', /medical|health|doctor|clinic/i, 0.6],
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

export function fromBankCategory(bankCategory: string | null, leaves: Leaf[], amount = 0): PayeeAnswer | null {
  if (!bankCategory) return null;
  // A few dollars at a gas station is a snack or a drink, not fuel.
  if (bankCategory.startsWith('TRANSPORTATION_GAS') && amount < 0 && Math.abs(amount) < SMALL_STOP) {
    const snack = leaves.find((l) => /snack|coffee/i.test(l.path.split(' › ').pop()!));
    return snack ? { categoryId: snack.id, confidence: 0.65 } : null;
  }
  for (const [prefix, re, conf] of BANK_MAP) {
    if (!bankCategory.startsWith(prefix)) continue;
    const leaf = leaves.find((l) => re.test(l.path.split(' › ').pop()!));
    return leaf ? { categoryId: leaf.id, confidence: conf } : null;
  }
  return null;
}

// ---------- Claude ----------

const SYSTEM =
  'You sort bank transactions for a family budget in Columbus, Ohio. For each payee, choose the single best budget category id from the list, ' +
  'or null if none fits or the payee is too ambiguous to tell (for example a superstore that sells groceries and household goods). ' +
  'Amounts matter: a few dollars at a gas station is a snack, not fuel. ' +
  'Confidence is your probability (0 to 1) that the household would agree. Be honest: use below 0.8 whenever a person would need to check. ' +
  'In "about", say in under 12 words what the business is if you know (e.g. "MealPay Plus: school lunch account payments"), else null.';

const ASSIGN_TOOL = {
  name: 'assign_categories',
  description: 'Record the category for each payee.',
  input_schema: {
    type: 'object',
    properties: {
      results: {
        type: 'array',
        items: {
          type: 'object',
          properties: { key: { type: 'string' }, category_id: { type: ['string', 'null'] }, confidence: { type: 'number' }, about: { type: ['string', 'null'] } },
          required: ['key', 'category_id', 'confidence'],
        },
      },
    },
    required: ['results'],
  },
};

type Content = { type: string; name?: string; input?: Record<string, unknown> }[];

export class ClaudeClassifier implements PayeeClassifier {
  constructor(private apiKey: string, private model = 'claude-haiku-5-5', private fetchImpl: typeof fetch = fetch,
    private searchTool = process.env.HEARTH_WEB_SEARCH_TOOL || 'web_search_20250305') {}

  private async call(body: Record<string, unknown>): Promise<Content> {
    const res = await this.fetchImpl('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.model, ...body }),
    });
    if (!res.ok) throw new Error(`Claude request failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
    return ((await res.json()) as { content: Content }).content;
  }

  private read(content: Content, batch: PayeeQuestion[], leaves: Leaf[], out: Map<string, PayeeAnswer>) {
    const ids = new Set(leaves.map((l) => l.id));
    const block = content.find((c) => c.type === 'tool_use' && (c.name ?? 'assign_categories') === 'assign_categories');
    const results = (block?.input?.results ?? []) as { key: string; category_id: string | null; confidence: number; about?: string | null }[];
    for (const r of results) {
      if (!batch.some((p) => p.key === r.key)) continue;
      const cat = r.category_id && ids.has(r.category_id) ? r.category_id : null;
      out.set(r.key, { categoryId: cat, confidence: cat ? Math.max(0, Math.min(1, Number(r.confidence) || 0)) : 0, about: typeof r.about === 'string' ? r.about.slice(0, 120) : null });
    }
  }

  private payload(batch: PayeeQuestion[], leaves: Leaf[]) {
    return JSON.stringify({
      categories: leaves.map((l) => ({ id: l.id, name: l.path })),
      payees: batch.map((p) => ({ key: p.key, payee: p.merchant, recent_amounts_usd: p.amounts.map((a) => Math.abs(a) / 100), bank_category: p.bankCategory })),
    });
  }

  async classify(payees: PayeeQuestion[], leaves: Leaf[]) {
    const out = new Map<string, PayeeAnswer>();
    for (let i = 0; i < payees.length; i += 40) {
      const batch = payees.slice(i, i + 40);
      const content = await this.call({
        max_tokens: 4096, system: SYSTEM, tools: [ASSIGN_TOOL], tool_choice: { type: 'tool', name: 'assign_categories' },
        messages: [{ role: 'user', content: this.payload(batch, leaves) }],
      });
      this.read(content, batch, leaves, out);
    }
    return out;
  }

  /** Looks payees up on the web (a few searches per batch), then answers as in classify. */
  async research(payees: PayeeQuestion[], leaves: Leaf[]) {
    const out = new Map<string, PayeeAnswer>();
    for (let i = 0; i < payees.length; i += 5) {
      const batch = payees.slice(i, i + 5);
      const content = await this.call({
        max_tokens: 4096,
        system: SYSTEM + ' These payee names were not recognized. Search the web to find out what each business is (bank descriptors are often truncated), ' +
          'then call assign_categories once with every payee.',
        tools: [{ type: this.searchTool, name: 'web_search', max_uses: 2 * batch.length, user_location: { type: 'approximate', city: 'Columbus', region: 'Ohio', country: 'US' } }, ASSIGN_TOOL],
        messages: [{ role: 'user', content: this.payload(batch, leaves) }],
      });
      this.read(content, batch, leaves, out);
    }
    return out;
  }

  async suggestTag(t: { merchant: string; amount: number; about?: string | null; date: string }) {
    const content = await this.call({
      max_tokens: 200,
      system: 'Give a short, plain label (1 to 3 words, Title Case) for what this one-off household expense most likely was, like "Car Repair", "Birthday Gift", "Doctor Visit". No punctuation.',
      tools: [{ name: 'set_tag', description: 'Record the label.', input_schema: { type: 'object', properties: { tag: { type: 'string' } }, required: ['tag'] } }],
      tool_choice: { type: 'tool', name: 'set_tag' },
      messages: [{ role: 'user', content: JSON.stringify({ payee: t.merchant, amount_usd: Math.abs(t.amount) / 100, date: t.date, about: t.about ?? undefined }) }],
    });
    const tag = content.find((c) => c.type === 'tool_use')?.input?.tag;
    return typeof tag === 'string' && tag.trim() ? tag.trim().slice(0, 40) : null;
  }
}

export function classifierFromEnv(env = process.env): PayeeClassifier | null {
  return env.ANTHROPIC_API_KEY ? new ClaudeClassifier(env.ANTHROPIC_API_KEY, env.HEARTH_AGENT_MODEL || undefined) : null;
}

// ---------- the run ----------

export async function leavesFor(db: Db, hid: string): Promise<Leaf[]> {
  const rows = await db.query<{ id: string; name: string; parent_id: string | null; kind: string | null; months: number[] | null }>(
    'SELECT id, name, parent_id, kind, months FROM categories WHERE household_id = $1 AND NOT archived', [hid]);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const hasKids = new Set(rows.map((r) => r.parent_id).filter(Boolean));
  const path = (r: (typeof rows)[number]): string => (r.parent_id && byId.get(r.parent_id) ? `${path(byId.get(r.parent_id)!)} › ${r.name}` : r.name);
  return rows.filter((r) => !hasKids.has(r.id)).map((r) => ({ id: r.id, path: path(r), kind: r.kind, months: r.months }));
}

export interface AgentResult { remembered: number; model: number; bank: number; claude: number; review: number; researched?: number; claudeError?: string }

interface Candidate { id: string; merchant: string; raw_name: string | null; bank_category: string | null; amount_cents: number; date: string }

export async function runAgent(db: Db, hid: string, opts: { classifier?: PayeeClassifier | null; today: string; windowDays?: number }): Promise<AgentResult> {
  const result = await sortTransactions(db, hid, opts);
  // Newly sorted bill payments may belong to the next month (rent paid on the 31st).
  await assignBudgetMonths(db, hid);
  return result;
}

async function sortTransactions(db: Db, hid: string, opts: { classifier?: PayeeClassifier | null; today: string; windowDays?: number }): Promise<AgentResult> {
  const windowDays = opts.windowDays ?? 90;
  const since = new Date(Date.parse(opts.today + 'T12:00:00Z') - windowDays * 86400_000).toISOString().slice(0, 10);
  const res: AgentResult = { remembered: 0, model: 0, bank: 0, claude: 0, review: 0 };
  // Miscellaneous is only ever chosen by a person, so it's left out of everything automatic.
  const leaves = (await leavesFor(db, hid)).filter((l) => l.kind !== 'misc');
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

  // Payments people already sorted into a bill's category count toward learning that bill's due day.
  const unlinked = await db.query<{ id: string }>("SELECT id FROM transactions WHERE household_id = $1 AND category_id IS NOT NULL AND schedule_id IS NULL AND amount_cents < 0 AND external_id IS NOT NULL", [hid]);
  await linkBills(db, unlinked.map((u) => u.id));
  await assignBudgetMonths(db, hid);

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

  // What a normal amount looks like for each category, from the household's own sorted purchases. An automatic
  // match far outside that range ($4.50 "fuel") becomes a suggestion to check instead.
  const amounts = new Map<string, number[]>();
  for (const t of training) if (t.amount_cents < 0) amounts.set(t.category_id, [...(amounts.get(t.category_id) ?? []), -t.amount_cents]);
  const fuelIds = new Set(leaves.filter((l) => /fuel|gasoline/i.test(l.path.split(' › ').pop()!)).map((l) => l.id));
  const snack = leaves.find((l) => /snack|coffee/i.test(l.path.split(' › ').pop()!));
  const fits = (catId: string | null, amount: number) => {
    if (!catId || amount >= 0) return true;
    const a = -amount;
    const list = (amounts.get(catId) ?? []).sort((x, y) => x - y);
    if (list.length >= 4) {
      const p10 = list[Math.floor(list.length * 0.1)]!, p90 = list[Math.min(list.length - 1, Math.floor(list.length * 0.9))]!;
      return a >= p10 * 0.35 && a <= p90 * 3;
    }
    return !(fuelIds.has(catId) && a < SMALL_STOP);
  };
  /** When a fuel match is too small, the likelier answer is a snack. */
  const smallStop = (t: Candidate, catId: string | null) => fuelIds.has(catId ?? '') && snack && !fits(catId, t.amount_cents) ? { categoryId: snack.id, confidence: 0.65 } : null;

  const best = new Map<string, PayeeAnswer>();
  const consider = (id: string, a: PayeeAnswer | null) => {
    if (!a?.categoryId) return;
    const cur = best.get(id);
    if (!cur || a.confidence > cur.confidence) best.set(id, a);
  };
  const assign = async (t: Candidate, a: PayeeAnswer, source: string) => {
    await db.query("UPDATE transactions SET category_id = $1, source = $2, confidence = $3, needs_review = FALSE, suggested_category_id = NULL WHERE id = $4",
      [a.categoryId, source, a.confidence, t.id]);
    await linkBills(db, [t.id]);
  };

  const left: Candidate[] = [];
  for (const t of todo) {
    const p = model.predict(features(t.merchant, t.raw_name, t.bank_category, t.amount_cents));
    if (p && p.evidence && p.confidence >= CONFIDENT && fits(p.categoryId, t.amount_cents)) { await assign(t, p, 'agent'); res.model++; continue; }
    // A guess with no evidence behind it (only Plaid's category and the amount) isn't worth showing.
    if (p?.evidence) consider(t.id, fits(p.categoryId, t.amount_cents) ? p : smallStop(t, p.categoryId) ?? { categoryId: p.categoryId, confidence: 0.5 });
    // 3. Plaid's category (amount-aware for gas stations).
    const b = fromBankCategory(t.bank_category, leaves, t.amount_cents);
    if (b && b.confidence >= CONFIDENT && fits(b.categoryId, t.amount_cents)) { await assign(t, b, 'bank'); res.bank++; continue; }
    consider(t.id, b && !fits(b.categoryId, t.amount_cents) ? { ...b, confidence: 0.5 } : b);
    left.push(t);
  }
  todo = left;

  // 4. Claude: remembered answers first, then ask about new payees in the review window.
  const hints = new Map((await db.query<{ merchant_key: string; category_id: string | null; confidence: number | null; researched: boolean }>(
    "SELECT merchant_key, category_id, confidence, researched FROM payee_hints WHERE household_id = $1 AND source = 'claude'", [hid])).map((h) => [h.merchant_key, h]));
  const saveHint = async (key: string, a: PayeeAnswer, researched: boolean) => {
    await db.query(
      `INSERT INTO payee_hints (household_id, merchant_key, category_id, confidence, about, researched, source) VALUES ($1,$2,$3,$4,$5,$6,'claude')
       ON CONFLICT (household_id, merchant_key) DO UPDATE SET category_id = EXCLUDED.category_id, confidence = EXCLUDED.confidence,
         about = COALESCE(EXCLUDED.about, payee_hints.about), researched = payee_hints.researched OR EXCLUDED.researched, source = 'claude', updated_at = now()`,
      [hid, key, a.categoryId, a.confidence, a.about ?? null, researched]);
    hints.set(key, { merchant_key: key, category_id: a.categoryId, confidence: a.confidence, researched });
  };
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
        for (const q of questions) await saveHint(q.key, answers.get(q.key) ?? { categoryId: null, confidence: 0 }, false);
      } catch (e) {
        res.claudeError = (e as Error).message;
      }
    }

    // 4b. Payees Claude couldn't place: look them up on the web, once each (a handful per run keeps cost to cents).
    if (opts.classifier.research) {
      const unknown = new Map<string, PayeeQuestion>();
      for (const t of todo) {
        const key = norm(t.merchant);
        const h = hints.get(key);
        if (!key || !h || h.researched || (h.confidence ?? 0) >= CONFIDENT || t.date < since) continue;
        const q = unknown.get(key) ?? { key, merchant: t.merchant, amounts: [], bankCategory: t.bank_category };
        if (q.amounts.length < 3) q.amounts.push(t.amount_cents);
        unknown.set(key, q);
      }
      const look = [...unknown.values()].slice(0, 15);
      if (look.length) {
        try {
          const found = await opts.classifier.research(look, leaves);
          for (const q of look) {
            const prev = hints.get(q.key)!;
            const a = found.get(q.key) ?? { categoryId: prev.category_id, confidence: prev.confidence ?? 0 };
            await saveHint(q.key, a, true);
            res.researched = (res.researched ?? 0) + 1;
          }
        } catch (e) {
          res.claudeError = (e as Error).message;
        }
      }
    }
  }
  for (const t of todo) {
    const h = hints.get(norm(t.merchant));
    const a = h?.category_id && leafIds.has(h.category_id) ? { categoryId: h.category_id, confidence: h.confidence ?? 0 } : null;
    if (a && a.confidence >= CONFIDENT && fits(a.categoryId, t.amount_cents)) { await assign(t, a, 'claude'); res.claude++; continue; }
    consider(t.id, a && !fits(a.categoryId, t.amount_cents) ? smallStop(t, a.categoryId) ?? { ...a, confidence: 0.5 } : a);
    // 5. Recent ones a person should look at; older history just stays unsorted.
    if (t.date >= since) {
      const s = best.get(t.id);
      await db.query('UPDATE transactions SET needs_review = TRUE, suggested_category_id = $1, confidence = $2 WHERE id = $3', [s?.categoryId ?? null, s?.confidence ?? null, t.id]);
      res.review++;
    }
  }
  return res;
}
