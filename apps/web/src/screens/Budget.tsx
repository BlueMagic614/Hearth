import { useState } from 'react';
import { parseCents, type CategoryNode } from '@hearth/core';
import { api, type BudgetView } from '../api';
import { Bar, Icon, MonthPicker, PageHead, Remaining, Tip, Toast, useLoad, usd } from '../components/ui';

interface Props { month: string; setMonth: (m: string) => void; onBreakdown: (parentId: string) => void }

export function Budget({ month, setMonth, onBreakdown }: Props) {
  const { data, error, reload } = useLoad(() => api.get<BudgetView>(`/api/budget?month=${month}`), [month]);
  const [editing, setEditing] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
  const [adding, setAdding] = useState<{ parentId: string; name: string; amount: string } | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [newParent, setNewParent] = useState('Other');
  const [toast, setToast] = useState<{ message: string; undo?: () => Promise<void> } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const run = async (fn: () => Promise<unknown>) => {
    try { setFailure(null); await fn(); reload(); } catch (e) { setFailure((e as Error).message); }
  };

  const commitRename = () => {
    if (!renaming) return;
    const value = renaming.value.trim();
    setRenaming(null);
    if (value) run(() => api.patch(`/api/categories/${renaming.id}`, { name: value }));
  };
  const setPlanned = (id: string, raw: string) => run(() => api.patch(`/api/categories/${id}`, { planned: parseCents(raw) / 100, month }));
  const addCategory = () => {
    if (!adding) return;
    const a = adding;
    setAdding(null);
    run(() => api.post('/api/categories', { name: a.name.trim() || 'New category', parentId: a.parentId, planned: parseCents(a.amount) / 100, month }));
  };
  const remove = (n: CategoryNode, mode: 'all' | 'ungroup') => {
    setConfirming(null);
    run(async () => {
      const r = await api.del<{ archived: string[] }>(`/api/categories/${n.id}?mode=${mode}`);
      if (mode === 'all') setToast({ message: `Deleted ${n.name}`, undo: async () => { await api.post('/api/categories/restore', { ids: r.archived }); reload(); } });
      else setToast({ message: `Ungrouped ${n.name}` });
    });
  };
  const group = (target: { parentId?: string; newParentName?: string }) => {
    const ids = [...selected];
    setSelected(new Set());
    run(() => api.post('/api/categories/group', { ids, month, ...target }));
  };
  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  if (error) return <div className="card">Couldn't load the budget: {error}</div>;
  if (!data) return <div className="muted">Loading…</div>;

  const left = data.leftToAssign;
  const tops = data.tree;

  const nameCell = (n: CategoryNode, size: number, weight: number) =>
    renaming?.id === n.id ? (
      <input className="input sm" autoFocus value={renaming.value} aria-label="Category name" style={{ width: 220, fontWeight: weight }}
        onChange={(e) => setRenaming({ id: n.id, value: e.target.value })} onBlur={commitRename}
        onKeyDown={(e) => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setRenaming(null); }} />
    ) : (
      <span style={{ fontSize: size, fontWeight: weight }}>{n.name}</span>
    );

  const plannedCell = (n: CategoryNode, strong = false) =>
    editing && n.children.length === 0 ? (
      <input className="input sm num" style={{ width: 104 }} inputMode="decimal" aria-label={`Planned for ${n.name}`}
        defaultValue={(n.planned / 100).toFixed(2)} key={`${n.id}-${n.planned}`}
        onBlur={(e) => { if (parseCents(e.target.value) !== n.planned) setPlanned(n.id, e.target.value); }}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
    ) : (
      <span style={{ fontWeight: strong ? 600 : 400, color: 'var(--ink-2)' }}>{usd(n.totalPlanned)}</span>
    );

  const actions = (n: CategoryNode, isTop: boolean) =>
    editing && (
      <div className="c-actions">
        <button className="icon-btn" title="Rename" aria-label={`Rename ${n.name}`} onClick={() => setRenaming({ id: n.id, value: n.name })}>{Icon.pencil}</button>
        {n.children.length > 0 || isTop ? (
          <button className="icon-btn" title="Add category" aria-label={`Add a category to ${n.name}`} onClick={() => setAdding({ parentId: n.id, name: '', amount: '' })}>{Icon.plus}</button>
        ) : (
          <button className="icon-btn" title="Split into subcategories" aria-label={`Split ${n.name} into subcategories`}
            onClick={() => run(async () => { await api.post(`/api/categories/${n.id}/split`, { month }); setAdding({ parentId: n.id, name: '', amount: '' }); })}>{Icon.split}</button>
        )}
        <button className="icon-btn danger" title="Delete" aria-label={`Delete ${n.name}`} onClick={() => (n.children.length ? setConfirming(n.id) : remove(n, 'all'))}>{Icon.trash}</button>
      </div>
    );

  const addForm = (parentId: string, indent: number) =>
    adding?.parentId === parentId && (
      <div className="screen" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: `8px 6px 10px ${indent}px` }}>
        <input className="input sm" autoFocus placeholder="Category name" aria-label="New category name" style={{ flex: '1 1 200px' }} value={adding.name}
          onChange={(e) => setAdding({ ...adding, name: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') addCategory(); if (e.key === 'Escape') setAdding(null); }} />
        <input className="input sm num" placeholder="$ per month" aria-label="Monthly amount" inputMode="decimal" style={{ width: 120 }} value={adding.amount}
          onChange={(e) => setAdding({ ...adding, amount: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') addCategory(); }} />
        <button className="btn sm accent" onClick={addCategory}>Add</button>
        <button className="btn sm ghost" onClick={() => setAdding(null)}>Cancel</button>
      </div>
    );

  const confirmBox = (n: CategoryNode, indent: number) =>
    confirming === n.id && (
      <div className="notice warn screen" style={{ margin: `4px 6px 8px ${indent}px` }}>
        <span style={{ flex: '1 1 220px' }}>Remove {n.name}? It holds {n.children.length} {n.children.length === 1 ? 'category' : 'categories'}.</span>
        <button className="btn sm" onClick={() => remove(n, 'ungroup')}>Keep what's inside</button>
        <button className="btn sm danger" onClick={() => remove(n, 'all')}>Delete all</button>
        <button className="btn sm ghost" onClick={() => setConfirming(null)}>Cancel</button>
      </div>
    );

  const check = (n: CategoryNode) =>
    editing && (
      <span className="c-check">
        <input type="checkbox" checked={selected.has(n.id)} onChange={() => toggle(n.id)} aria-label={`Select ${n.name}`} style={{ width: 18, height: 18, accentColor: 'var(--accent)' }} />
      </span>
    );

  const renderNode = (n: CategoryNode, depth: number, isTop: boolean) => (
    <div key={n.id} className={isTop ? 'bparent' : undefined}>
      <div className="brow" style={{ fontSize: isTop ? 15 : depth > 1 ? 13 : 14 }}>
        {editing && (isTop && n.children.length ? <span className="c-check" /> : check(n))}
        <div className="name" style={{ paddingLeft: isTop ? 0 : 14 + (depth - 1) * 24 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {nameCell(n, isTop ? 15 : depth > 1 ? 13 : 14, isTop ? 600 : 400)}
            {n.children.length > 1 && <span className="small count" style={{ color: 'var(--faint)' }}>{n.children.length} {isTop ? 'categories' : 'subcategories'}</span>}
            {isTop && n.children.length > 1 && !editing && (
              <button className="btn sm ghost" style={{ color: 'var(--accent)', padding: '0 6px' }} aria-label={`Breakdown of ${n.name}`} onClick={() => onBreakdown(n.id)}><span className="bd-text">Breakdown </span>→</button>
            )}
          </div>
          {!isTop && <div style={{ maxWidth: 260, marginTop: 7 }}><Bar spent={n.totalSpent} planned={n.totalPlanned} /></div>}
        </div>
        <span className="c-planned">{plannedCell(n, isTop)}</span>
        <span className="c-spent">{usd(n.totalSpent)}</span>
        <span className="c-left" style={{ fontWeight: isTop ? 600 : 500 }}><Remaining planned={n.totalPlanned} spent={n.totalSpent} /></span>
        {actions(n, isTop)}
      </div>
      {confirmBox(n, isTop ? 34 : 54)}
      {n.children.map((c) => renderNode(c, depth + 1, false))}
      {addForm(n.id, isTop ? 40 : 60)}
    </div>
  );

  const moveTargets = tops.filter((t) => !selected.has(t.id));

  return (
    <div className="stack screen">
      <PageHead sub="Zero-based: give every dollar a job" title="Budget"><MonthPicker month={month} onChange={setMonth} /></PageHead>

      <div className="row-wrap">
        <div className="card grow"><div className="stat-label">Take-home this month</div><div className="stat-value" style={{ fontSize: 24 }}>{usd(data.income)}</div></div>
        <div className="card grow"><div className="stat-label">Planned</div><div className="stat-value" style={{ fontSize: 24 }}>{usd(data.plannedTotal)}</div></div>
        <div className="card grow">
          <div className="stat-label">Left to assign <Tip label="About left to assign" text="Take-home pay minus everything planned. It updates as you add, delete or re-amount categories. Aim for $0." /></div>
          <div className={'stat-value ' + (left === 0 ? 'good' : 'warn')} style={{ fontSize: 24 }}>{left < 0 ? '−' : ''}{usd(Math.abs(left), true)}</div>
          {left < 0 && <div className="stat-note warn">You've planned more than you'll take home.</div>}
        </div>
      </div>

      <div className="card" style={{ padding: '8px 22px 16px' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '12px 0', borderBottom: '1px solid var(--line)' }}>
          <div className="stat-label" style={{ flex: '1 1 260px' }}>
            {editing ? 'Rename, re-amount, split or delete. Tick categories to move or group them.' : 'Tap Edit categories to add, delete, split or regroup.'}
            <Tip label="About parent categories" text="Parents hold categories, and any category can be split into subcategories. Totals roll up. Moving a category keeps all of its transactions." />
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {editing && <button className="btn" onClick={() => run(async () => { const r = await api.post<{ id: string }>('/api/categories', { name: 'New category', parentId: null, month }); setRenaming({ id: r.id, value: 'New category' }); })}>+ New parent category</button>}
            <button className="btn primary" onClick={() => { commitRename(); setEditing(!editing); setSelected(new Set()); setAdding(null); setConfirming(null); }}>{editing ? 'Done' : 'Edit categories'}</button>
          </div>
        </div>

        {failure && <div className="notice warn" style={{ marginTop: 12 }}>{failure}</div>}

        {selected.size > 0 && (
          <div className="notice good screen" style={{ marginTop: 12 }}>
            <strong>{selected.size} selected</strong>
            <span>Move to</span>
            {moveTargets.map((t) => <button key={t.id} className="btn sm" onClick={() => group({ parentId: t.id })}>{t.name}</button>)}
            <span style={{ marginLeft: 4 }}>or group under a new parent</span>
            <input className="input sm" style={{ width: 140 }} value={newParent} onChange={(e) => setNewParent(e.target.value)} aria-label="New parent name" />
            <button className="btn sm accent" onClick={() => group({ newParentName: newParent.trim() || 'Other' })}>Group</button>
            <button className="btn sm ghost" onClick={() => setSelected(new Set())}>Clear</button>
          </div>
        )}

        <div className="table-scroll">
          <div className="btable">
            <div className="brow bhead">
              {editing && <span className="c-check" />}
              <span className="name">Category</span><span className="c-planned">Planned</span><span className="c-spent">Spent</span><span className="c-left">Remaining</span>
              {editing && <span className="c-actions" />}
            </div>
            {tops.map((t) => renderNode(t, 0, true))}
          </div>
        </div>
      </div>

      {toast && <Toast message={toast.message} action={toast.undo ? 'Undo' : undefined} onAction={() => { toast.undo?.(); setToast(null); }} onClose={() => setToast(null)} />}
    </div>
  );
}
