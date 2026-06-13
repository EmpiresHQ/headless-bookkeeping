import { AssetClass } from '../plugins/fixed-asset.types';

/** The per-class FIXED_ASSETS_* (cost) and ACCUM_DEPRECIATION_* (contra) codes. */
export interface ClassAccounts {
  fixedAssetCode: string;
  accumDepreciationCode: string;
}

/**
 * The single source of the asset-class → account-code binding (ADR-0035).
 * Both the registrar (which detects a FIXED_ASSETS_* line) and the disposal /
 * depreciation posting read from here, so the two cannot diverge.
 */
export const CLASS_ACCOUNTS: Readonly<Record<AssetClass, ClassAccounts>> = {
  vehicle: {
    fixedAssetCode: 'FIXED_ASSETS_VEHICLES',
    accumDepreciationCode: 'ACCUM_DEPRECIATION_VEHICLES',
  },
  it_equipment: {
    fixedAssetCode: 'FIXED_ASSETS_IT',
    accumDepreciationCode: 'ACCUM_DEPRECIATION_IT',
  },
  machinery: {
    fixedAssetCode: 'FIXED_ASSETS_EQUIPMENT',
    accumDepreciationCode: 'ACCUM_DEPRECIATION_EQUIPMENT',
  },
  furniture: {
    fixedAssetCode: 'FIXED_ASSETS_FURNITURE',
    accumDepreciationCode: 'ACCUM_DEPRECIATION_FURNITURE',
  },
};

/** All four FIXED_ASSETS_* codes — used to detect a capex line on a voucher. */
export const FIXED_ASSET_CODES: readonly string[] = Object.values(
  CLASS_ACCOUNTS,
).map((c) => c.fixedAssetCode);

/** The asset class owning a FIXED_ASSETS_* code, or undefined if not one. */
export function assetClassForAccount(code: string): AssetClass | undefined {
  return (Object.keys(CLASS_ACCOUNTS) as AssetClass[]).find(
    (k) => CLASS_ACCOUNTS[k].fixedAssetCode === code,
  );
}
