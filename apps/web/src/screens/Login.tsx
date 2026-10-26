import { useState } from 'react';
import { api } from '../api';

export function Login({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="login">
      <form className="card screen" onSubmit={async (e) => {
        e.preventDefault(); setBusy(true); setErr(null);
        try { await api.post('/api/auth/login', { email, password }); onDone(); } catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
      }}>
        <div className="brand" style={{ padding: 0 }}><span className="brand-mark"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 11.5 12 5l8 6.5" /><path d="M7 10v9h10v-9" /></svg></span>Hearth</div>
        <h1 style={{ fontSize: 22 }}>Sign in</h1>
        <label className="field">Email<input className="input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
        <label className="field">Password<input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
        {err && <div className="notice warn">{err}</div>}
        <button className="btn accent" type="submit" disabled={busy} style={{ height: 44, justifyContent: 'center' }}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </div>
  );
}

export function ChangePassword({ onDone }: { onDone: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="login">
      <form className="card screen" onSubmit={async (e) => {
        e.preventDefault(); setErr(null);
        try { await api.post('/api/me/password', { current, next }); onDone(); } catch (x) { setErr((x as Error).message); }
      }}>
        <h1 style={{ fontSize: 22 }}>Choose your password</h1>
        <div className="muted" style={{ fontSize: 14 }}>You're using the starter password. Pick your own, at least 10 characters.</div>
        <label className="field">Starter password<input className="input" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required /></label>
        <label className="field">New password<input className="input" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} minLength={10} required /></label>
        {err && <div className="notice warn">{err}</div>}
        <button className="btn accent" type="submit" style={{ height: 44, justifyContent: 'center' }}>Save password</button>
      </form>
    </div>
  );
}
