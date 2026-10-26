/** All money in Hearth is stored and computed as integer cents to avoid floating-point drift. */
export type Cents = number;

export const toCents = (dollars: number): Cents => Math.round(dollars * 100);
export const fromCents = (c: Cents): number => c / 100;

/** Parses user input like "$1,234.56" or "1234.5" into cents. Returns 0 for empty or invalid input. */
export function parseCents(input: string | number): Cents {
  if (typeof input === 'number') return toCents(input);
  const cleaned = input.replace(/[^0-9.\-]/g, '');
  const n = Number.parseFloat(cleaned);
  return Number.isFinite(n) ? toCents(n) : 0;
}

/** Formats cents as US dollars. Negative values use a true minus sign. */
export function formatUSD(c: Cents, opts: { cents?: boolean } = {}): string {
  const showCents = opts.cents ?? c % 100 !== 0;
  const abs = Math.abs(c) / 100;
  const body = abs.toLocaleString('en-US', {
    minimumFractionDigits: showCents ? 2 : 0,
    maximumFractionDigits: showCents ? 2 : 0,
  });
  return (c < 0 ? '−' : '') + '$' + body;
}
