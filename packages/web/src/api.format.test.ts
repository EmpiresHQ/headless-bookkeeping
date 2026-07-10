import { describe, expect, it } from 'vitest';
import { fmtCents } from './api';
import { signedEuros } from './inbox/format';

describe('minus-glyph decision (U+2212 app-wide, Plan 06 Task 2)', () => {
  it('fmtCents emits the typographic minus for negatives', () => {
    expect(fmtCents(-4820)).toBe('−48.20');
    expect(fmtCents(4820)).toBe('48.20');
    expect(fmtCents(0)).toBe('0.00');
  });

  it('signedEuros signs with U+2212 / ASCII +', () => {
    expect(signedEuros(-4820)).toBe('−48.20 €');
    expect(signedEuros(4820)).toBe('+48.20 €');
    expect(signedEuros(0)).toBe('0.00 €');
  });
});
