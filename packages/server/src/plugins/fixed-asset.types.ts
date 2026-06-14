/**
 * The four fixed-asset classes (ADR-0035). These ARE the new expense category
 * keys an operator picks at intake; each maps to a per-class FIXED_ASSETS_*
 * account that carries the useful life.
 */
export type AssetClass = 'vehicle' | 'it_equipment' | 'machinery' | 'furniture';

/** Depreciation methods a plugin may declare. v1 supports straight-line only. */
export type DepreciationMethod = 'straight_line';

/**
 * Per-class depreciation norms supplied by the country plugin (ADR-0002): the
 * kernel never hardcodes Estonian lives/residuals. `defaultResidualMinor` is in
 * base-currency minor units and is 0 for every class except vehicle.
 */
export interface FixedAssetDefaults {
  defaultUsefulLifeYears: number;
  defaultResidualMinor: number;
}
