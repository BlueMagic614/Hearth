import { useState } from 'react';
import { api, type ConnectionView, type ConnectionsView, type SyncResult } from '../api';
import { PageHead, Tip, Toast, usd, useLoad } from '../components/ui';

declare global {
  interface Window {
    Plaid?: {
      create(opts: {
        token: string;
        onSuccess: (publicToken: string, meta: { institution?: { institution_id?: string; name?: string } | null }) => void;
        onExit?: (err: { error_message?: string; display_message?: string } | null) => void;
      }): { open(): void; destroy(): void };
    };
  }
}

/** Plaid Link is Plaid's own sign-in window: Kemba credentials go to Plaid, never to Hearth. */
let plaidScript: Promise<void> | null = null;
const loadPlaid = () =>
  (plaidScript ??= new Promise<void>((resolve, reject) => {
    if (window.Plaid) return resolve();
    const s = document.createElement('script');
    s.src = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js';
    s.onload = () => resolve();
    s.onerror = () => { plaidScript = null; reject(new Error("Couldn't load Plaid's sign-in window. Check your connection and try again.")); };
    document.head.appendChild(s);
  }));

const ago = (iso: string | null) => {
  if (!iso) return 'never';
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h} hr ago`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};
const summary = (r: SyncResult | null) => {
  if (!r) return 'Connected. Kemba is still sending history; it will appear within a few minutes.';
  const parts = [`${r.added} new`, r.modified ? `${r.modified} updated` : '', r.removed ? `${r.removed} removed` : '', r.categorized ? `${r.categorized} sorted automatically` : '', r.learnedDates ? `${r.learnedDates} due date${r.learnedDates === 1 ? '' : 's'} learned` : ''];
  return `Synced: ${parts.filter(Boolean).join(', ')}.`;
};

export function Accounts() {
  const data = useLoad(() => api.get<ConnectionsView>('/api/connections'), []);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  /** Opens Plaid Link. With a connection, opens it in repair mode to sign in to Kemba again. */
  const openLink = async (repair?: ConnectionView) => {
    setErr(null);
    setBusy(repair ? repair.id : 'connect');
    try {
      await loadPlaid();
      const { linkToken } = await api.post<{ linkToken: string }>('/api/plaid/link-token', repair ? { connectionId: repair.id } : {});
      const handler = window.Plaid!.create({
        token: linkToken,
        onSuccess: async (publicToken, meta) => {
          try {
            if (repair) {
              const r = await api.post<{ result: SyncResult }>(`/api/connections/${repair.id}/sync`);
              setToast(`Kemba reconnected. ${summary(r.result)}`);
            } else {
              const r = await api.post<{ result: SyncResult | null }>('/api/plaid/exchange', {
                publicToken, institution: { id: meta.institution?.institution_id, name: meta.institution?.name },
              });
              setToast(summary(r.result));
            }
          } catch (e) { setErr((e as Error).message); }
          finally { setBusy(null); handler.destroy(); data.reload(); }
        },
        onExit: (e) => {
          setBusy(null);
          handler.destroy();
          if (e) setErr(e.display_message || e.error_message || 'The bank sign-in was closed before it finished.');
        },
      });
      handler.open();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(null);
    }
  };

  const sync = async (c: ConnectionView) => {
    setErr(null);
    setBusy(c.id);
    try {
      const r = await api.post<{ result: SyncResult }>(`/api/connections/${c.id}/sync`);
      setToast(summary(r.result));
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(null); data.reload(); }
  };

  const disconnect = async (c: ConnectionView) => {
    if (!confirm(`Disconnect ${c.institution ?? 'this bank'}? Your transaction history stays in Hearth; new activity stops arriving.`)) return;
    setBusy(c.id);
    try { await api.del(`/api/connections/${c.id}`); setToast('Disconnected. History kept.'); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(null); data.reload(); }
  };

  const d = data.data;
  const env = d?.environment;
  return (
    <div className="stack screen">
      <PageHead sub="Balances and transactions straight from your bank" title="Accounts">
        {d?.configured && d.keyReady && (
          <button className="btn accent" disabled={!!busy} onClick={() => openLink()}>{busy === 'connect' ? 'Opening…' : d.connections.length ? 'Connect another' : 'Connect Kemba'}</button>
        )}
      </PageHead>

      {data.error && <div className="notice warn">{data.error}</div>}
      {err && <div className="notice warn">{err}</div>}

      {d && !d.configured && (
        <div className="card stack">
          <h2>Bank sync isn't switched on yet</h2>
          <p className="muted">The server needs its Plaid keys (PLAID_CLIENT_ID and a PLAID_SECRET) in Render → hearth → Environment. Once they're saved and the service restarts, a Connect Kemba button appears here.</p>
        </div>
      )}
      {d?.configured && !d.keyReady && (
        <div className="notice warn">One more setting is needed before connecting: HEARTH_ENCRYPTION_KEY in Render → hearth → Environment (it protects your bank connection at rest).</div>
      )}
      {env === 'sandbox' && (
        <div className="notice good">
          Practice mode: this connects to Plaid's test banks, not Kemba. In the bank picker choose any bank (e.g. "First Platypus Bank") and sign in with <b>user_good</b> / <b>pass_good</b>.
          <Tip label="About practice mode" text="Once Plaid approves your production access and its secret is saved on the server, this switches to real Kemba automatically. Practice data can be disconnected afterwards." />
        </div>
      )}

      {d?.connections.map((c) => (
        <div className="card stack" key={c.id}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 200px' }}>
              <h2>{c.institution ?? 'Bank'}{c.environment === 'sandbox' && <span className="muted small" style={{ fontWeight: 400 }}> · practice</span>}</h2>
              <div className="muted small" style={{ marginTop: 2 }}>
                {c.status === 'ok' && <>Updated {ago(c.lastSyncedAt)} · new activity arrives automatically</>}
                {c.status === 'error' && <span className="warn-text">Last sync failed{c.lastError ? `: ${c.lastError}` : ''}</span>}
                {c.status === 'login_required' && <span className="warn-text">Kemba needs you to sign in again</span>}
              </div>
            </div>
            {c.status === 'login_required'
              ? <button className="btn accent sm" disabled={!!busy} onClick={() => openLink(c)}>Sign in again</button>
              : <button className="btn sm" disabled={!!busy} onClick={() => sync(c)}>{busy === c.id ? 'Syncing…' : 'Sync now'}</button>}
            <button className="btn ghost sm" disabled={!!busy} onClick={() => disconnect(c)}>Disconnect</button>
          </div>
          <div>
            {c.accounts.map((a) => (
              <div key={a.id} className="list-row">
                <span style={{ flex: '1 1 160px' }}>
                  <span style={{ fontWeight: 500 }}>{a.name}</span>
                  <span className="muted small"> {a.mask ? `···${a.mask}` : ''} · {a.subtype ?? a.type}</span>
                </span>
                <span style={{ textAlign: 'right' }}>
                  <span style={{ fontWeight: 600, display: 'block' }}>{usd(a.balance, true)}</span>
                  {a.available !== null && a.available !== a.balance && a.type === 'checking' && (
                    <span className="muted small">{usd(a.available, true)} available
                      <Tip label="About available balance" text="Available leaves out pending charges and holds. The forecast starts from the current balance and subtracts upcoming bills itself." />
                    </span>
                  )}
                </span>
              </div>
            ))}
          </div>
        </div>
      ))}

      {d && d.configured && d.connections.length === 0 && (
        <div className="card stack">
          <h2>Connect Kemba once, and Hearth keeps itself up to date</h2>
          <ul className="muted" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.7 }}>
            <li>You sign in through Plaid's window; Hearth never sees your Kemba password.</li>
            <li>Up to a year of history comes in, and payments are matched to your bills.</li>
            <li>Bills paid twice teach Hearth their real due day, unless you've set the date yourself.</li>
            <li>The forecast starts from your real checking balance.</li>
          </ul>
        </div>
      )}

      {d && d.manualAccounts.length > 0 && (
        <div className="card">
          <h2>Entered by hand</h2>
          {d.manualAccounts.map((a) => (
            <div key={a.id} className="list-row">
              <span style={{ flex: 1 }}>{a.name} <span className="muted small">· replaced automatically once Kemba checking is connected</span></span>
              <span style={{ fontWeight: 600 }}>{usd(a.balance, true)}</span>
            </div>
          ))}
        </div>
      )}

      {toast && <Toast message={toast} onClose={() => setToast(null)} />}
    </div>
  );
}
