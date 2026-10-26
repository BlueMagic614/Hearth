import { breakdownOf, type CategoryNode, type CategoryRow } from '@hearth/core';
import { api, type BudgetView } from '../api';
import { MonthPicker, PageHead, Tip, useLoad, usd } from '../components/ui';

const flatten = (nodes: CategoryNode[]): CategoryRow[] =>
  nodes.flatMap((n) => [{ id: n.id, name: n.name, parentId: n.parentId, sortOrder: n.sortOrder, planned: n.planned, spent: n.spent, kind: n.kind }, ...flatten(n.children)]);

export function Insights({ month, setMonth, parentId, setParentId }: { month: string; setMonth: (m: string) => void; parentId: string | null; setParentId: (id: string) => void }) {
  const { data } = useLoad(() => api.get<BudgetView>(`/api/budget?month=${month}`), [month]);
  if (!data) return <div className="muted">Loading…</div>;

  const parents = data.tree.filter((t) => t.children.length > 0);
  const chosen = parents.find((p) => p.id === parentId) ?? parents.find((p) => p.name.toLowerCase() === 'other') ?? parents[0];
  const parts = chosen ? breakdownOf(flatten(data.tree), chosen.id) : [];
  const maxSpent = Math.max(1, ...parts.map((p) => p.spent));
  const nonSavings = data.tree.filter((t) => t.kind !== 'savings').reduce((s, t) => s + t.totalSpent, 0);
  const allocMax = Math.max(1, ...data.tree.map((t) => t.totalPlanned));

  return (
    <div className="stack screen">
      <PageHead sub="Where the money goes" title="Insights"><MonthPicker month={month} onChange={setMonth} /></PageHead>

      {chosen && (
        <section className="card">
          <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 6 }}>
            <div className="stat-label"><h2 style={{ color: 'var(--ink)' }}>Inside a parent category</h2>
              <Tip label="About this breakdown" text="Pick any parent to see where its money goes. Use it on Other to see what extra cash goes to outside bills, food and savings. Subcategories roll into their category." /></div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {parents.map((p) => <button key={p.id} className="chip" aria-pressed={p.id === chosen.id} onClick={() => setParentId(p.id)}>{p.name}</button>)}
            </div>
          </div>
          <div style={{ fontSize: 13, color: 'var(--ink-2)', marginBottom: 14 }}>
            {chosen.name}: {usd(chosen.totalSpent)} spent of {usd(chosen.totalPlanned)} planned
            {nonSavings > 0 && ` · ${Math.round((chosen.totalSpent / nonSavings) * 100)}% of everything spent outside savings`}
          </div>
          {chosen.totalSpent === 0 && <div className="muted small" style={{ marginBottom: 10 }}>No spending recorded here yet this month, so bars show planned amounts.</div>}
          {parts.map((p) => {
            const value = chosen.totalSpent === 0 ? p.planned : p.spent;
            const max = chosen.totalSpent === 0 ? Math.max(1, ...parts.map((x) => x.planned)) : maxSpent;
            return (
              <div key={p.id} style={{ padding: '7px 0' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 13, marginBottom: 5 }}>
                  <span>{p.name}</span>
                  <span><strong>{usd(p.spent)}</strong> <span className="muted">of {usd(p.planned)}{chosen.totalSpent > 0 ? ` · ${Math.round(p.share * 100)}%` : ''}</span></span>
                </div>
                <div className="bar-track" style={{ height: 8 }}><div className={'bar-fill' + (p.spent > p.planned ? ' over' : '')} style={{ width: `${(value / max) * 100}%`, background: chosen.totalSpent === 0 ? 'var(--chart-partial)' : undefined }} /></div>
                {p.children.length > 0 && <div className="small muted" style={{ marginTop: 4 }}>{p.children.map((c) => `${c.name} ${usd(c.spent)}`).join(' · ')}</div>}
              </div>
            );
          })}
        </section>
      )}

      <section className="card">
        <div className="stat-label" style={{ marginBottom: 10 }}><h2 style={{ color: 'var(--ink)' }}>Where this month's pay goes</h2>
          <Tip label="About allocation" text="Each top-level group's planned share of this month's take-home pay." /></div>
        {[...data.tree].sort((a, b) => b.totalPlanned - a.totalPlanned).map((t) => (
          <div key={t.id} style={{ padding: '6px 0' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 5 }}><span>{t.name}</span><span className="muted">{usd(t.totalPlanned)} · {Math.round((t.totalPlanned / Math.max(1, data.income)) * 100)}%</span></div>
            <div className="bar-track" style={{ height: 8 }}><div className="bar-fill" style={{ width: `${(t.totalPlanned / allocMax) * 100}%`, background: 'var(--chart-1)' }} /></div>
          </div>
        ))}
      </section>
    </div>
  );
}
