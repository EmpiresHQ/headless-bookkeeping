import { describe, expect, it } from 'vitest';
import { absoluteDate, absoluteDateFromIso, vatRatePct } from './format';

describe('absolute dates', () => {
  it('formats unix seconds as dd.mm.yyyy', () => {
    // 2026-07-03T10:00:00Z
    expect(absoluteDate(Date.UTC(2026, 6, 3, 12) / 1000)).toMatch(
      /^0?3\.07\.2026$/,
    );
  });
  it('formats ISO dates as dd.mm.yyyy', () => {
    expect(absoluteDateFromIso('2026-07-03')).toBe('03.07.2026');
  });
});

describe('vatRatePct', () => {
  it('derives the implied rate from VAT-inclusive facts', () => {
    expect(vatRatePct(8900, 1605)).toBe(22); // 1605 / 7295 ≈ 0.22
  });
  it('returns null when not computable', () => {
    expect(vatRatePct(0, 0)).toBeNull();
    expect(vatRatePct(100, 100)).toBeNull();
  });
});
