import { describe, expect, it } from 'vitest';
import {
  amountError,
  centsToEuroInput,
  MAX_EXACT_AMOUNT,
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
  it('converts large amounts exactly, never moving a cent (#265)', () => {
    // parseFloat(x) * 100 gave 9007199254740991 / 7036874417766402 here.
    expect(eurosToCents('90071992547409.90')).toBe(9007199254740990);
    expect(eurosToCents('70368744177664.01')).toBe(7036874417766401);
    expect(eurosToCents('90071992547409.91')).toBe(Number.MAX_SAFE_INTEGER);
    expect(eurosToCents('-90071992547409.91')).toBe(-Number.MAX_SAFE_INTEGER);
    expect(eurosToCents('1,1')).toBe(110);
  });
  it('rejects amounts past the exact-integer range instead of rounding', () => {
    expect(eurosToCents('90071992547409.92')).toBeNull();
    expect(eurosToCents('100000000000000000000')).toBeNull();
    expect(eurosToCents('-90071992547409.92')).toBeNull();
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

describe('amountError (#265)', () => {
  const gross = {
    blank: 'Enter the gross',
    sign: 'positive',
    what: 'Gross',
  } as const;
  const vat = {
    blank: 'Enter the VAT',
    sign: 'nonNegative',
    what: 'VAT',
  } as const;
  it('names what is wrong: blank, format, too large, sign', () => {
    expect(amountError('  ', gross)).toBe('Enter the gross');
    expect(amountError('12.345', gross)).toMatch(/at most 2 decimals/);
    expect(amountError('abc', gross)).toMatch(/like 12\.40/);
    expect(amountError('90071992547409.92', gross)).toBe(
      `Too large to record exactly — at most ${MAX_EXACT_AMOUNT}`,
    );
    expect(MAX_EXACT_AMOUNT).toBe('90071992547409.91');
    expect(amountError('0', gross)).toBe('Gross must be greater than zero');
    expect(amountError('-1', vat)).toBe('VAT cannot be negative');
  });
  it('accepts what eurosToCents accepts in range', () => {
    expect(amountError('0', vat)).toBeNull();
    expect(amountError('12,40', gross)).toBeNull();
    expect(amountError('90071992547409.91', gross)).toBeNull();
  });
});
