import { describe, expect, it } from 'vitest';
import {
  centsToEuroInput,
  eurosToCents,
  signedEuros,
  signedMoney,
  vatFromGross,
} from './money';

describe('eurosToCents', () => {
  it('parses plain euros', () => {
    expect(eurosToCents('89')).toBe(8900);
  });
  it('parses dot and comma decimals', () => {
    expect(eurosToCents('89.05')).toBe(8905);
    expect(eurosToCents('89,05')).toBe(8905);
  });
  it('rejects garbage and >2 decimals', () => {
    expect(eurosToCents('abc')).toBeNull();
    expect(eurosToCents('1.234')).toBeNull();
    expect(eurosToCents('')).toBeNull();
  });
  it('accepts negative amounts', () => {
    expect(eurosToCents('-12.50')).toBe(-1250);
  });
});

describe('centsToEuroInput', () => {
  it('renders cents as an editable euro string', () => {
    expect(centsToEuroInput(8905)).toBe('89.05');
  });
});

describe('vatFromGross', () => {
  it('extracts the VAT portion of a VAT-inclusive gross', () => {
    // 18.60 € gross at 22% → 3.35 € VAT (matches the mockup's Wolt line).
    expect(vatFromGross(1860, 22)).toBe(335);
  });
  it('is zero at rate 0', () => {
    expect(vatFromGross(1860, 0)).toBe(0);
  });
});

describe('signedEuros — the app-wide signed-display idiom (Plan 07 Task 1)', () => {
  it('signs by the input sign: U+2212 minus, ASCII plus, zero unsigned', () => {
    expect(signedEuros(-4820)).toBe('−48.20 €');
    expect(signedEuros(4820)).toBe('+48.20 €');
    expect(signedEuros(0)).toBe('0.00 €');
  });

  it('cannot double-sign: negating an already-negative value yields a plus', () => {
    // The failure mode this idiom kills: a literal '−' prefixed to
    // fmtCents(negative) would render '−−48.20'. signedEuros signs exactly
    // once, whatever the caller passes.
    expect(signedEuros(-(-4820))).toBe('+48.20 €');
    expect(signedEuros(-0)).toBe('0.00 €');
  });
});

describe('signedMoney — signedEuros for an explicit currency', () => {
  it('keeps the exact EUR output and uses the ISO code otherwise, unconverted', () => {
    expect(signedMoney(-120000, 'EUR')).toBe(signedEuros(-120000));
    expect(signedMoney(-120000, 'USD')).toBe('−1200.00 USD');
    expect(signedMoney(4820, 'DKK')).toBe('+48.20 DKK');
    expect(signedMoney(0, 'GBP')).toBe('0.00 GBP');
  });
});
