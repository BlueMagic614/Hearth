import type { Cents } from './money';

/** A category row as stored: a flat list linked by parentId. Any depth is allowed. */
export interface CategoryRow {
  id: string;
  name: string;
  parentId: string | null;
  sortOrder: number;
  /** Planned amount for the month. Only leaves carry money; a parent's own planned is ignored. */
  planned: Cents;
  spent: Cents;
  /** Free-form kind used by analytics: 'bill', 'everyday', 'savings', 'debt', 'giving'. */
  kind?: string | null;
}

export interface CategoryNode extends CategoryRow {
  children: CategoryNode[];
  /** Rolled-up totals (equal to planned/spent for a leaf). */
  totalPlanned: Cents;
  totalSpent: Cents;
  depth: number;
}

/** Builds the tree from flat rows, sorted by sortOrder then name, and rolls up totals. */
export function buildTree(rows: CategoryRow[]): CategoryNode[] {
  const nodes = new Map<string, CategoryNode>();
  for (const r of rows) nodes.set(r.id, { ...r, children: [], totalPlanned: 0, totalSpent: 0, depth: 0 });
  const roots: CategoryNode[] = [];
  for (const n of nodes.values()) {
    const parent = n.parentId ? nodes.get(n.parentId) : undefined;
    if (parent) parent.children.push(n);
    else roots.push(n);
  }
  const sortRec = (list: CategoryNode[], depth: number) => {
    list.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
    for (const n of list) {
      n.depth = depth;
      sortRec(n.children, depth + 1);
      if (n.children.length) {
        n.totalPlanned = n.children.reduce((s, c) => s + c.totalPlanned, 0);
        n.totalSpent = n.children.reduce((s, c) => s + c.totalSpent, 0);
      } else {
        n.totalPlanned = n.planned;
        n.totalSpent = n.spent;
      }
    }
  };
  sortRec(roots, 0);
  return roots;
}

export function leaves(nodes: CategoryNode[]): CategoryNode[] {
  return nodes.flatMap((n) => (n.children.length ? leaves(n.children) : [n]));
}

/** Ids of a node and everything under it. */
export function subtreeIds(rows: CategoryRow[], id: string): Set<string> {
  const out = new Set<string>([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const r of rows) {
      if (r.parentId && out.has(r.parentId) && !out.has(r.id)) {
        out.add(r.id);
        grew = true;
      }
    }
  }
  return out;
}

/** True if moving `id` under `newParentId` would create a cycle. */
export function wouldCycle(rows: CategoryRow[], id: string, newParentId: string | null): boolean {
  if (newParentId === null) return false;
  return subtreeIds(rows, id).has(newParentId);
}

export function totalPlanned(rows: CategoryRow[]): Cents {
  return leaves(buildTree(rows)).reduce((s, n) => s + n.planned, 0);
}

/** Zero-based budgeting: income minus every planned dollar. */
export function leftToAssign(income: Cents, rows: CategoryRow[]): Cents {
  return income - totalPlanned(rows);
}

export interface Breakdown {
  id: string;
  name: string;
  spent: Cents;
  planned: Cents;
  /** Share of the parent's spending, 0–1. */
  share: number;
  children: { id: string; name: string; spent: Cents }[];
}

/** Direct-child breakdown of one parent, biggest spending first. Subcategories roll into their category. */
export function breakdownOf(rows: CategoryRow[], parentId: string): Breakdown[] {
  const tree = buildTree(rows);
  const find = (list: CategoryNode[]): CategoryNode | undefined => {
    for (const n of list) {
      if (n.id === parentId) return n;
      const f = find(n.children);
      if (f) return f;
    }
    return undefined;
  };
  const parent = find(tree);
  if (!parent) return [];
  const total = parent.totalSpent || 1;
  return parent.children
    .map((c) => ({
      id: c.id,
      name: c.name,
      spent: c.totalSpent,
      planned: c.totalPlanned,
      share: c.totalSpent / total,
      children: c.children.map((s) => ({ id: s.id, name: s.name, spent: s.totalSpent })),
    }))
    .sort((a, b) => b.spent - a.spent);
}
