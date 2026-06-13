/**
 * The pure, deterministic straight-line depreciation engine (ADR-0035 §5).
 *
 * Depreciable base = cost − residual, spread straight-line over the useful
 * life, accrued pro-rata by WHOLE MONTHS from the acquisition date, and capped
 * so accumulated depreciation never exceeds the depreciable base (the asset
 * settles at its residual value, not zero). No DB, no NestJS, no I/O — the LLM
 * never picks a figure. The SAME engine the year-end close (a separate plan)
 * calls virtually.
 *
 * Amounts are base-currency minor units (integer cents). Dates are ISO
 * YYYY-MM-DD strings.
 */
export interface DepreciableAsset {
  acquisition_date: string;
  cost_base_minor: number;
  useful_life_years: number;
  residual_value_minor: number;
}

/** Whole months elapsed from `from` (inclusive of its month) up to and
 *  including the month of `to`. A same-month pair counts as 1 month; a date
 *  before the acquisition month counts as 0. */
function monthsElapsed(from: string, to: string): number {
  const [fy, fm] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  const months = (ty - fy) * 12 + (tm - fm) + 1;
  return months < 0 ? 0 : months;
}

/**
 * Accumulated depreciation from acquisition through `asOf` (inclusive of the
 * asOf month), rounded to whole cents, capped at the depreciable base.
 */
export function accumulatedDepreciationAsOf(
  asset: DepreciableAsset,
  asOf: string,
): number {
  const depreciableBase = asset.cost_base_minor - asset.residual_value_minor;
  if (depreciableBase <= 0 || asset.useful_life_years <= 0) return 0;

  const totalMonths = asset.useful_life_years * 12;
  const monthlyRate = depreciableBase / totalMonths;

  const elapsed = monthsElapsed(asset.acquisition_date, asOf);
  if (elapsed <= 0) return 0;

  const accrued = Math.round(monthlyRate * elapsed);
  return Math.min(accrued, depreciableBase);
}

/**
 * The depreciation charge to recognise BETWEEN `from` and `to`: the difference
 * in accumulated depreciation. `from = null` means "from acquisition" (the
 * catch-up case with no prior close). Never negative (a fully-depreciated asset
 * accrues nothing further).
 */
export function depreciationCharge(
  asset: DepreciableAsset,
  from: string | null,
  to: string,
): number {
  const accumTo = accumulatedDepreciationAsOf(asset, to);
  const accumFrom = from === null ? 0 : accumulatedDepreciationAsOf(asset, from);
  return Math.max(0, accumTo - accumFrom);
}
