import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Db } from './db';
import { newId } from './auth';
import type { Assistant } from './assistant';
import { HttpError, notFound } from './errors';

export async function registerAssistantRoutes(app: FastifyInstance, db: Db, { assistant, hid }: { assistant: Assistant | null; hid: (req: FastifyRequest) => string }) {
  app.get('/api/assistant', async (req) => {
    const conversations = await db.query<{ id: string; title: string; updated_at: Date; who: string | null }>(
      `SELECT c.id, c.title, c.updated_at, u.name AS who FROM assistant_conversations c LEFT JOIN users u ON u.id = c.user_id
       WHERE c.household_id = $1 ORDER BY c.updated_at DESC LIMIT 30`, [hid(req)]);
    return { enabled: !!assistant, model: assistant?.model ?? null, conversations };
  });

  app.get('/api/assistant/:id', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const c = (await db.query('SELECT id FROM assistant_conversations WHERE id = $1 AND household_id = $2', [id, hid(req)]))[0];
    if (!c) throw notFound();
    const messages = await db.query<{ role: string; content: string; tools: string[] | null; created_at: Date; who: string | null }>(
      `SELECT m.role, m.content, m.tools, m.created_at, u.name AS who FROM assistant_messages m LEFT JOIN users u ON u.id = m.user_id
       WHERE m.conversation_id = $1 ORDER BY m.created_at, m.id`, [id]);
    return { id, messages };
  });

  app.delete('/api/assistant/:id', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await db.query('DELETE FROM assistant_conversations WHERE id = $1 AND household_id = $2', [id, hid(req)]);
    return { ok: true };
  });

  /** Ask a question, in a new conversation or continuing one. */
  app.post('/api/assistant/ask', async (req) => {
    if (!assistant) throw new HttpError(503, 'The assistant needs ANTHROPIC_API_KEY set in Render → hearth → Environment.');
    const b = z.object({ conversationId: z.string().optional(), message: z.string().trim().min(1).max(2000) }).parse(req.body);
    const h = hid(req);
    let convId = b.conversationId;
    if (convId) {
      const c = (await db.query('SELECT id FROM assistant_conversations WHERE id = $1 AND household_id = $2', [convId, h]))[0];
      if (!c) throw notFound();
    } else {
      convId = newId();
      await db.query('INSERT INTO assistant_conversations (id, household_id, user_id, title) VALUES ($1,$2,$3,$4)', [convId, h, req.user!.id, b.message.slice(0, 80)]);
    }
    const prior = await db.query<{ role: 'user' | 'assistant'; content: string }>('SELECT role, content FROM assistant_messages WHERE conversation_id = $1 ORDER BY created_at, id', [convId]);
    await db.query("INSERT INTO assistant_messages (id, conversation_id, role, content, user_id) VALUES ($1,$2,'user',$3,$4)", [newId(), convId, b.message, req.user!.id]);
    let out: { text: string; tools: string[] };
    try {
      out = await assistant.answer(db, h, [...prior, { role: 'user', content: b.message }], req.user!.name);
    } catch (e) {
      throw new HttpError(502, `The assistant couldn't answer just now: ${(e as Error).message}`);
    }
    await db.query("INSERT INTO assistant_messages (id, conversation_id, role, content, tools) VALUES ($1,$2,'assistant',$3,$4)", [newId(), convId, out.text, out.tools]);
    await db.query('UPDATE assistant_conversations SET updated_at = now() WHERE id = $1', [convId]);
    return { conversationId: convId, answer: out.text, tools: out.tools };
  });
}
