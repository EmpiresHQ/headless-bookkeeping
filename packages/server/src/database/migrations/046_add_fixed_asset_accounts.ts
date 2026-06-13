import { Kysely } from 'kysely';
import { Database } from '../types';

/**
 * Migration 046 (ADR-0035): seed neutral fixed-asset accounts.
 *  - FIXED_ASSETS_* (asset)            — capitalized cost, per class.
 *  - ACCUM_DEPRECIATION_* (asset)      — contra-asset, accumulated kulum per class.
 *  - DEPRECIATION_EXPENSE (expense)    — the P&L charge.
 *  - GAIN_LOSS_ON_ASSET_DISPOSAL (revenue) — põhivara müügi kasum/kahjum; a net
 *    gain is a credit (revenue-normal), a net loss a debit. Modelled as revenue
 *    so it nets into the P&L on the credit-normal side.
 * Inserted into the existing account table (002), is_system = 1. No new table.
 */
const SEED: Array<{
  code: string;
  name: string;
  type: string;
  currency: string | null;
}> = [
  { code: 'FIXED_ASSETS_VEHICLES', name: 'Fixed Assets — Vehicles', type: 'asset', currency: null },
  { code: 'FIXED_ASSETS_IT', name: 'Fixed Assets — IT Equipment', type: 'asset', currency: null },
  { code: 'FIXED_ASSETS_EQUIPMENT', name: 'Fixed Assets — Equipment', type: 'asset', currency: null },
  { code: 'FIXED_ASSETS_FURNITURE', name: 'Fixed Assets — Furniture', type: 'asset', currency: null },
  { code: 'ACCUM_DEPRECIATION_VEHICLES', name: 'Accumulated Depreciation — Vehicles', type: 'asset', currency: null },
  { code: 'ACCUM_DEPRECIATION_IT', name: 'Accumulated Depreciation — IT Equipment', type: 'asset', currency: null },
  { code: 'ACCUM_DEPRECIATION_EQUIPMENT', name: 'Accumulated Depreciation — Equipment', type: 'asset', currency: null },
  { code: 'ACCUM_DEPRECIATION_FURNITURE', name: 'Accumulated Depreciation — Furniture', type: 'asset', currency: null },
  { code: 'DEPRECIATION_EXPENSE', name: 'Depreciation Expense', type: 'expense', currency: null },
  { code: 'GAIN_LOSS_ON_ASSET_DISPOSAL', name: 'Gain/Loss on Asset Disposal', type: 'revenue', currency: null },
];

export async function up(db: Kysely<Database>): Promise<void> {
  for (const a of SEED) {
    await db
      .insertInto('account')
      .values({
        code: a.code,
        name: a.name,
        type: a.type,
        currency: a.currency,
        parent_id: null,
        is_system: 1,
      })
      .execute();
  }
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db
    .deleteFrom('account')
    .where('code', 'in', SEED.map((a) => a.code) as [string, ...string[]])
    .execute();
}
