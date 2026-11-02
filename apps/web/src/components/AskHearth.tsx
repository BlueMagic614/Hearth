import { Fragment, useEffect, useRef, useState } from 'react';
import { api } from '../api';

interface Msg { role: 'user' | 'assistant'; content: string; tools?: string[] | null; who?: string | null }
interface Conv { id: string; title: string; updated_at: string; who: string | null }

const TOOL_LABEL: Record<string, string> = {
  get_budget: 'budget', get_transactions: 'transactions', spending_by: 'spending history', get_paycheck_plan: 'paycheck plan', get_forecast: 'balance forecast',
  get_bills: 'bills', get_cash: 'cash envelopes', get_debt_and_goals: 'loans & goals', simulate_payoff: 'payoff what-if',
};
const SUGGESTIONS = [
  'Which check is paying for Columbia Gas this month?',
  'Can we afford a $400 car repair this month without touching savings?',
  'Where did our money go last month?',
  'If we put the February bonus on FirstMark instead, when are we debt-free?',
];

/** Minimal, safe formatting for answers: paragraphs, bullet lists and **bold**. No HTML is ever injected. */
function Rich({ text }: { text: string }) {
  const bold = (s: string) => s.split(/(\*\*[^*]+\*\*)/g).map((part, i) => (part.startsWith('**') && part.endsWith('**') ? <b key={i}>{part.slice(2, -2)}</b> : <Fragment key={i}>{part}</Fragment>));
  const blocks: JSX.Element[] = [];
  let list: string[] = [];
  const flush = () => { if (list.length) { blocks.push(<ul key={blocks.length}>{list.map((l, i) => <li key={i}>{bold(l)}</li>)}</ul>); list = []; } };
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(?:[-*•]|\d+\.)\s+(.*)$/);
    if (m) { list.push(m[1]!); continue; }
    flush();
    if (line.trim()) blocks.push(<p key={blocks.length}>{bold(line.replace(/^#+\s*/, ''))}</p>);
  }
  flush();
  return <>{blocks}</>;
}

/** "Ask Hearth": a chat panel that answers from the household's data. Opens from a floating button. */
export function AskHearth() {
  const [open, setOpen] = useState(false);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [convs, setConvs] = useState<Conv[]>([]);
  const [conv, setConv] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);

  const loadList = () => api.get<{ enabled: boolean; conversations: Conv[] }>('/api/assistant').then((r) => { setEnabled(r.enabled); setConvs(r.conversations); }).catch(() => setEnabled(false));
  useEffect(() => { if (open) { loadList(); setTimeout(() => box.current?.focus(), 50); } }, [open]);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [msgs, busy]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    if (open) addEventListener('keydown', k);
    return () => removeEventListener('keydown', k);
  }, [open]);

  const openConv = async (id: string) => {
    setShowHistory(false);
    const r = await api.get<{ messages: Msg[] }>(`/api/assistant/${id}`);
    setConv(id);
    setMsgs(r.messages);
  };
  const newChat = () => { setConv(null); setMsgs([]); setErr(null); setShowHistory(false); box.current?.focus(); };

  const ask = async (q: string) => {
    const message = q.trim();
    if (!message || busy) return;
    setErr(null);
    setText('');
    setMsgs((m) => [...m, { role: 'user', content: message }]);
    setBusy(true);
    try {
      const r = await api.post<{ conversationId: string; answer: string; tools: string[] }>('/api/assistant/ask', { conversationId: conv ?? undefined, message });
      setConv(r.conversationId);
      setMsgs((m) => [...m, { role: 'assistant', content: r.answer, tools: r.tools }]);
      loadList();
    } catch (e) {
      setErr((e as Error).message);
    } finally { setBusy(false); }
  };

  return (
    <>
      {!open && (
        <button className="ask-fab" onClick={() => setOpen(true)} aria-label="Ask Hearth">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z" /></svg>
          <span>Ask Hearth</span>
        </button>
      )}
      {open && (
        <aside className="ask-panel" role="dialog" aria-label="Ask Hearth">
          <header className="ask-head">
            <b>Ask Hearth</b>
            <div style={{ display: 'flex', gap: 4 }}>
              {convs.length > 0 && <button className="btn sm ghost" onClick={() => setShowHistory(!showHistory)}>History</button>}
              <button className="btn sm ghost" onClick={newChat}>New chat</button>
              <button className="icon-btn" aria-label="Close" onClick={() => setOpen(false)}>×</button>
            </div>
          </header>

          {showHistory && (
            <div className="ask-history">
              {convs.map((c) => (
                <button key={c.id} className="ask-hist-row" onClick={() => openConv(c.id)}>
                  <span>{c.title}</span>
                  <span className="muted small">{c.who ? `${c.who} · ` : ''}{new Date(c.updated_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
                </button>
              ))}
            </div>
          )}

          <div className="ask-body">
            {enabled === false && (
              <div className="notice warn">The assistant is off until an Anthropic API key is saved on the server: Render → hearth → Environment → <b>ANTHROPIC_API_KEY</b>.</div>
            )}
            {msgs.length === 0 && enabled !== false && (
              <div className="ask-empty">
                <p className="muted">Ask about your budget, bills, paychecks, cash, loans or goals. Hearth looks up your numbers to answer. It can't change anything yet.</p>
                {SUGGESTIONS.map((s) => <button key={s} className="ask-suggest" onClick={() => ask(s)}>{s}</button>)}
              </div>
            )}
            {msgs.map((m, i) => (
              <div key={i} className={'ask-msg ' + m.role}>
                {m.role === 'assistant' ? <Rich text={m.content} /> : <p>{m.content}</p>}
                {m.role === 'assistant' && !!m.tools?.length && (
                  <div className="ask-tools">Looked at: {[...new Set(m.tools)].map((t) => TOOL_LABEL[t] ?? t).join(', ')}</div>
                )}
                {m.role === 'user' && m.who && <div className="ask-tools">{m.who}</div>}
              </div>
            ))}
            {busy && <div className="ask-msg assistant"><span className="ask-dots" aria-label="Thinking"><i /><i /><i /></span></div>}
            {err && <div className="notice warn">{err}</div>}
            <div ref={end} />
          </div>

          <form className="ask-input" onSubmit={(e) => { e.preventDefault(); ask(text); }}>
            <textarea ref={box} rows={2} className="input" placeholder="Ask about your money…" value={text} disabled={enabled === false}
              onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(text); } }} aria-label="Your question" />
            <button className="btn accent" type="submit" disabled={busy || !text.trim() || enabled === false}>Ask</button>
          </form>
        </aside>
      )}
    </>
  );
}
