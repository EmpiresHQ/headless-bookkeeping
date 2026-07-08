import { describe, expect, it } from 'vitest';
import { centsToEuroInput, eurosToCents } from './money';

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
