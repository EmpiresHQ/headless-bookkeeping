import { describe, expect, it } from 'vitest';
import {
  amountMatches,
  amountNeedle,
  isoDateMatches,
  searchNeedle,
  textMatches,
  unixDateMatches,
} from './searchText';

const n = (q: string) => {
  const needle = searchNeedle(q);
  if (needle === null) throw new Error('no needle');
  return needle;
};

describe('searchText (issue #278)', () => {
  it('a blank query is no search', () => {
    expect(searchNeedle('')).toBeNull();
    expect(searchNeedle('   \t')).toBeNull();
  });

  it('text: case-insensitive, whitespace runs collapsed, punctuation kept', () => {
    expect(textMatches(n('  TELIA   eesti '), ['Telia Eesti AS'])).toBe(true);
    expect(textMatches(n('inv-12/3'), ['INV-12/3'])).toBe(true);
    expect(textMatches(n('inv123'), ['INV-12/3'])).toBe(false);
    expect(textMatches(n('x'), [null, undefined, ''])).toBe(false);
  });

  it('amount: magnitudes in the usual spellings, sign ignored', () => {
    expect(amountNeedle('1 234,50 €')).toBe('1234.50');
    expect(amountNeedle('−12.30')).toBe('12.30');
    expect(amountNeedle('+89')).toBe('89');
    expect(amountNeedle('12.345')).toBeNull();
    expect(amountNeedle('telia')).toBeNull();
    expect(amountMatches(n('1234,5'), 123450)).toBe(true);
    expect(amountMatches(n('-18.60'), -1860)).toBe(true);
    expect(amountMatches(n('18.60'), 1860)).toBe(true);
    expect(amountMatches(n('18.61'), 1860)).toBe(false);
    // Not an amount → never an amount match; no amount → no match.
    expect(amountMatches(n('eur'), 1860)).toBe(false);
    expect(amountMatches(n('18'), null)).toBe(false);
  });

  it('date: ISO or "D Mon YYYY", as-is for ISO dates', () => {
    expect(isoDateMatches(n('2026-06-27'), '2026-06-27')).toBe(true);
    expect(isoDateMatches(n('2026-06'), '2026-06-27')).toBe(true);
    expect(isoDateMatches(n('27 Jun'), '2026-06-27')).toBe(true);
    expect(isoDateMatches(n('jun 2026'), '2026-06-27')).toBe(true);
    expect(isoDateMatches(n('7 jun'), '2026-06-07')).toBe(true);
    expect(isoDateMatches(n('28 jun'), '2026-06-27')).toBe(false);
    expect(isoDateMatches(n('jun'), 'garbage')).toBe(false);
  });

  it('date: a unix timestamp by its LOCAL calendar day', () => {
    const t = Math.floor(new Date('2026-07-07T23:30:00').getTime() / 1000);
    expect(unixDateMatches(n('7 jul 2026'), t)).toBe(true);
    expect(unixDateMatches(n('2026-07-07'), t)).toBe(true);
    expect(unixDateMatches(n('8 jul'), t)).toBe(false);
  });
});
