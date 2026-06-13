import {
  accumulatedDepreciationAsOf,
  depreciationCharge,
} from './depreciation-engine';

// A reusable asset shape — only the fields the engine reads.
const asset = (
  over: Partial<Parameters<typeof accumulatedDepreciationAsOf>[0]> = {},
) => ({
  acquisition_date: '2024-01-01',
  cost_base_minor: 1200000, // €12,000.00
  useful_life_years: 5,
  residual_value_minor: 0,
  ...over,
});

describe('depreciation engine — accumulatedDepreciationAsOf', () => {
  it('full first year (acquired Jan 1, 12/12) = annual charge', () => {
    // base = 1,200,000; /5 = 240,000 per year; 12 months → 240,000.
    expect(accumulatedDepreciationAsOf(asset(), '2024-12-31')).toBe(240000);
  });

  it('mid-year acquisition (Nov 1 → 2/12 of the year-1 charge)', () => {
    // Nov + Dec = 2 months. 240,000 * 2/12 = 40,000.
    expect(
      accumulatedDepreciationAsOf(
        asset({ acquisition_date: '2024-11-01' }),
        '2024-12-31',
      ),
    ).toBe(40000);
  });

  it('two full years = 2 × annual charge', () => {
    expect(accumulatedDepreciationAsOf(asset(), '2025-12-31')).toBe(480000);
  });

  it('caps at the depreciable base in the final year (never exceeds cost − residual)', () => {
    // Well past life: accumulated must equal the full depreciable base, not more.
    expect(accumulatedDepreciationAsOf(asset(), '2099-12-31')).toBe(1200000);
  });

  it('non-zero residual reduces the depreciable base (vehicle)', () => {
    // base = 2,000,000 − 400,000 = 1,600,000; /5 = 320,000/yr; 1 full year.
    const car = asset({
      cost_base_minor: 2000000,
      residual_value_minor: 400000,
    });
    expect(accumulatedDepreciationAsOf(car, '2024-12-31')).toBe(320000);
    // Past life: caps at 1,600,000 (asset settles at its €4,000 residual).
    expect(accumulatedDepreciationAsOf(car, '2099-12-31')).toBe(1600000);
  });

  it('is zero before the acquisition month', () => {
    expect(accumulatedDepreciationAsOf(asset(), '2023-12-31')).toBe(0);
  });
});

describe('depreciation engine — depreciationCharge (incremental)', () => {
  it('charge between two dates is the difference in accumulated', () => {
    // From end of year 1 (240,000) to end of year 2 (480,000) = 240,000.
    expect(depreciationCharge(asset(), '2024-12-31', '2025-12-31')).toBe(
      240000,
    );
  });

  it('catch-up from acquisition (no prior close) to a mid-year disposal', () => {
    // from = null ⇒ from acquisition. Acquired Jan 1; dispose Jun 30 = 6 months.
    // 240,000 * 6/12 = 120,000.
    expect(depreciationCharge(asset(), null, '2024-06-30')).toBe(120000);
  });

  it('never returns a negative charge once fully depreciated', () => {
    expect(depreciationCharge(asset(), '2099-01-01', '2099-12-31')).toBe(0);
  });
});
