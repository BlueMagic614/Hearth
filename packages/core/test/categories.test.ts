import { describe, expect, it } from 'vitest';
import { buildTree, breakdownOf, leftToAssign, wouldCycle, type CategoryRow } from '../src/categories';
import { toCents } from '../src/money';

const row = (id: string, name: string, parentId: string | null, planned = 0, spent = 0, sortOrder = 0): CategoryRow => ({
  id, name, parentId, planned: toCents(planned), spent: toCents(spent), sortOrder,
});

const rows: CategoryRow[] = [
  row('food', 'Food', null, 0, 0, 1),
  row('groc', 'Groceries', 'food', 1100, 812),
  row('other', 'Other', null, 0, 0, 2),
  row('rest', 'Restaurants & takeout', 'other', 300, 281, 1),
  row('hob', 'Hobbies', 'other', 0, 0, 2),
  row('gear', 'Music gear', 'hob', 50, 25),
  row('games', 'Games', 'hob', 25, 8),
  row('hair', 'Haircuts', 'other', 60, 40, 3),
];

describe('category tree', () => {
  it('rolls planned and spent up through every level', () => {
    const tree = buildTree(rows);
    const other = tree.find((n) => n.id === 'other')!;
    expect(other.totalPlanned).toBe(toCents(435));
    expect(other.totalSpent).toBe(toCents(354));
    expect(other.children.find((c) => c.id === 'hob')!.totalPlanned).toBe(toCents(75));
  });

  it('ignores money left on a parent once it has children', () => {
    const withStale = rows.map((r) => (r.id === 'hob' ? { ...r, planned: toCents(999) } : r));
    expect(buildTree(withStale).find((n) => n.id === 'other')!.totalPlanned).toBe(toCents(435));
  });

  it('computes left to assign from leaves only', () => {
    expect(leftToAssign(toCents(9716), rows)).toBe(toCents(9716 - 1535));
  });

  it('prevents moving a category under its own descendant', () => {
    expect(wouldCycle(rows, 'other', 'gear')).toBe(true);
    expect(wouldCycle(rows, 'hair', 'food')).toBe(false);
  });

  it('breaks a parent down by direct child, biggest first, with subcategories rolled in', () => {
    const b = breakdownOf(rows, 'other');
    expect(b.map((x) => x.name)).toEqual(['Restaurants & takeout', 'Haircuts', 'Hobbies']);
    expect(b[2]!.spent).toBe(toCents(33));
    expect(b[2]!.children.map((c) => c.name)).toEqual(['Games', 'Music gear']);
  });
});
