import { useEffect, useState } from 'react';
import { api, ApiError, type ConnectionsView, type Me } from './api';
import { Icon, thisMonth } from './components/ui';
import { Accounts } from './screens/Accounts';
import { Budget } from './screens/Budget';
import { Calendar } from './screens/Calendar';
import { Goals } from './screens/Goals';
import { Insights } from './screens/Insights';
import { ChangePassword, Login } from './screens/Login';
import { Today } from './screens/Today';
import { Transactions } from './screens/Transactions';

type Tab = 'today' | 'budget' | 'txns' | 'calendar' | 'goals' | 'insights' | 'accounts';
const TABS: { id: Tab; label: string; icon: JSX.Element; phone: boolean }[] = [
  { id: 'today', label: 'Today', icon: Icon.today, phone: true },
  { id: 'budget', label: 'Budget', icon: Icon.budget, phone: true },
  { id: 'txns', label: 'Transactions', icon: Icon.txns, phone: true },
  { id: 'calendar', label: 'Calendar', icon: Icon.calendar, phone: true },
  { id: 'goals', label: 'Goals', icon: Icon.goals, phone: true },
  { id: 'insights', label: 'Insights', icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></svg>, phone: false },
  { id: 'accounts', label: 'Accounts', icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 10 12 4l9 6M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 20h18" /></svg>, phone: false },
];

const tabFromHash = (): Tab => {
  const h = location.hash.replace('#', '') as Tab;
  return TABS.some((t) => t.id === h) ? h : 'today';
};

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [tab, setTab] = useState<Tab>(tabFromHash);
  const [month, setMonth] = useState(thisMonth());
  const [insParent, setInsParent] = useState<string | null>(null);
  const [bank, setBank] = useState<ConnectionsView | null>(null);

  const loadMe = () => api.get<Me>('/api/me').then(setMe).catch((e) => { if (e instanceof ApiError && e.status === 401) setMe(null); });
  useEffect(() => { loadMe(); }, []);
  useEffect(() => { if (me) api.get<ConnectionsView>('/api/connections').then(setBank).catch(() => {}); }, [me, tab]);
  useEffect(() => {
    const onHash = () => setTab(tabFromHash());
    addEventListener('hashchange', onHash);
    return () => removeEventListener('hashchange', onHash);
  }, []);
  const go = (t: string) => { location.hash = t; setTab(t as Tab); window.scrollTo({ top: 0 }); };

  if (me === undefined) return null;
  if (me === null) return <Login onDone={loadMe} />;
  if (me.mustChangePassword) return <ChangePassword onDone={loadMe} />;

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 11.5 12 5l8 6.5" /><path d="M7 10v9h10v-9" /></svg></span>Hearth</div>
        <nav className="nav" aria-label="Main">
          {TABS.map((t) => <button key={t.id} aria-current={tab === t.id ? 'page' : undefined} onClick={() => go(t.id)}>{t.icon}<span>{t.label}</span></button>)}
        </nav>
        <div style={{ padding: '0 8px', fontSize: 12 }} className="muted">
          Signed in as {me.name} · <button className="btn sm ghost" style={{ padding: 0, height: 'auto' }} onClick={() => api.post('/api/auth/logout').then(() => setMe(null))}>Sign out</button>
          <button className="btn sm ghost" style={{ padding: 0, height: 'auto', marginTop: 10, display: 'block', textAlign: 'left' }} onClick={() => go('accounts')}>
            <BankStatus bank={bank} />
          </button>
        </div>
      </aside>

      <main className="main" key={tab}>
        {tab === 'today' && <Today name={me.name} month={month} go={go} />}
        {tab === 'accounts' && <Accounts />}
        {tab === 'budget' && <Budget month={month} setMonth={setMonth} onBreakdown={(id) => { setInsParent(id); go('insights'); }} />}
        {tab === 'txns' && <Transactions month={month} setMonth={setMonth} />}
        {tab === 'calendar' && <Calendar month={month} setMonth={setMonth} />}
        {tab === 'goals' && <Goals />}
        {tab === 'insights' && <Insights month={month} setMonth={setMonth} parentId={insParent} setParentId={setInsParent} />}
      </main>

      <nav className="tabbar" aria-label="Main">
        {TABS.filter((t) => t.phone).map((t) => <button key={t.id} aria-current={tab === t.id ? 'page' : undefined} onClick={() => go(t.id)}>{t.icon}{t.label === 'Transactions' ? 'Spending' : t.label}</button>)}
      </nav>
    </div>
  );
}

function BankStatus({ bank }: { bank: ConnectionsView | null }) {
  if (!bank) return null;
  const c = bank.connections;
  if (!c.length) return <span className="muted">{bank.configured ? 'Kemba not connected · Connect' : 'Bank sync not set up'}</span>;
  if (c.some((x) => x.status === 'login_required')) return <span className="warn-text">Kemba needs sign-in again</span>;
  if (c.some((x) => x.status === 'error')) return <span className="warn-text">Bank sync problem · View</span>;
  const last = c.map((x) => x.lastSyncedAt).filter(Boolean).sort().pop();
  const mins = last ? Math.round((Date.now() - new Date(last).getTime()) / 60000) : null;
  return <span className="muted"><span className="live-dot" aria-hidden="true" />{c[0]!.institution?.replace(' Financial Credit Union', '') ?? 'Bank'} synced {mins === null ? '—' : mins < 1 ? 'just now' : mins < 60 ? `${mins} min ago` : `${Math.round(mins / 60)} hr ago`}</span>;
}
