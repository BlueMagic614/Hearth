import { describe, expect, it } from 'vitest';
import { formatUSD } from '../src/money';

describe('formatUSD', () => {
  it('rounds whole-dollar amounts up', () => {
    expect(formatUSD(323, { cents: false })).toBe('$4');
    expect(formatUSD(300, { cents: false })).toBe('$3');
    expect(formatUSD(-323, { cents: false })).toBe('−$4');
    expect(formatUSD(123456, { cents: false })).toBe('$1,235');
  });
  it('keeps exact cents when asked', () => {
    expect(formatUSD(323, { cents: true })).toBe('$3.23');
  });
});
