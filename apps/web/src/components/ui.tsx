import { useEffect, useState, type ReactNode } from 'react';
import { formatUSD } from '@hearth/core';

export const usd = (c: number, cents = false) => formatUSD(c, { cents });

export function Tip({ text, label }: { text: string; label: string }) {
  return <button type="button" className="tip" data-tip={text} aria-label={label}>?</button>;
}

export function Bar({ spent, planned }: { spent: number; planned: number }) {
  const pct = planned > 0 ? Math.min(100, Math.round((spent / planned) * 100)) : spent > 0 ? 100 : 0;
  return (
    <div className="bar-track" aria-hidden="true">
      <div className={'bar-fill' + (spent > planned ? ' over' : '')} style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Remaining({ planned, spent }: { planned: number; spent: number }) {
  const left = planned - spent;
  if (left < 0) return <span className="warn">{usd(-left)} over</span>;
  if (left === 0) return <span className="muted">{usd(0)}</span>;
  return <span>{usd(left)} left</span>;
}

export function Switch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return <button type="button" role="switch" aria-checked={on} aria-label={label} className="switch" onClick={() => onChange(!on)} />;
}

export function Toast({ message, action, onAction, onClose }: { message: string; action?: string; onAction?: () => void; onClose: () => void }) {
  useEffect(() => {
    const t = setTimeout(onClose, 6000);
    return () => clearTimeout(t);
  }, [message, onClose]);
  return (
    <div className="toast" role="status">
      <span>{message}</span>
      {action && <button onClick={onAction}>{action}</button>}
    </div>
  );
}

/** Loads data with a refresh function and a simple error state. */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    load().then((d) => live && (setData(d), setError(null))).catch((e: Error) => live && setError(e.message));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { data, error, reload: () => setTick((t) => t + 1) };
}

export function PageHead({ sub, title, children }: { sub?: string; title: string; children?: ReactNode }) {
  return (
    <header className="page-head">
      <div>
        {sub && <div className="sub">{sub}</div>}
        <h1>{title}</h1>
      </div>
      {children && <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>{children}</div>}
    </header>
  );
}

export function MonthPicker({ month, onChange }: { month: string; onChange: (m: string) => void }) {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const shift = (n: number) => {
    const idx = y * 12 + (m - 1) + n;
    onChange(`${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`);
  };
  const label = new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
      <button className="icon-btn" aria-label="Previous month" onClick={() => shift(-1)}>‹</button>
      <span style={{ minWidth: 120, textAlign: 'center', fontSize: 14, fontWeight: 500 }}>{label}</span>
      <button className="icon-btn" aria-label="Next month" onClick={() => shift(1)}>›</button>
    </div>
  );
}

export const thisMonth = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};
export const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export const Icon = {
  today: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>,
  budget: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true"><path d="M21 12A9 9 0 1 1 12 3v9z" /><path d="M15 3.5A9 9 0 0 1 20.5 9H15z" /></svg>,
  txns: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01" /></svg>,
  calendar: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><rect x="3" y="4.5" width="18" height="16" rx="3" /><path d="M3 9.5h18M8 2.5v4M16 2.5v4" /></svg>,
  goals: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 21V4" /><path d="M5 4h11l-2 4 2 4H5" /></svg>,
  pencil: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z" /></svg>,
  plus: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>,
  split: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 4v6a4 4 0 0 0 4 4h8M6 10v10M14 10l4 4-4 4" /></svg>,
  trash: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" /></svg>,
};
