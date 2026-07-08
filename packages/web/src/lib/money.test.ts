import { describe, expect, it } from 'vitest';
import { centsToEuroInput, eurosToCents, vatFromGross } from './money';

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
