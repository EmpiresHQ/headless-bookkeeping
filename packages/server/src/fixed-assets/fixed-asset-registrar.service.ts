import { Injectable } from '@nestjs/common';
import { Kysely } from 'kysely';
import { Database } from '../database/types';
import { PluginLoader } from '../plugins/plugin-loader.service';
import { PostedVoucher } from '../ledger/voucher/types';
import { AssetClass } from '../plugins/fixed-asset.types';
import { assetClassForAccount } from './fixed-asset-class-map';

/**
 * FixedAssetRegistrarService — the capex → register seam (ADR-0035 §3).
 *
 * Called as the posting pipeline's `afterPost` hook, INSIDE the posting
 * transaction. If the just-posted voucher carries a FIXED_ASSETS_* line, it
 * creates the fixed_asset register row from the source expense's intake payload
 * (asset name + optional overrides), defaulting useful life / residual from the
 * active country plugin per class. A non-capex voucher is a no-op.
 *
 * Reads the expense row AND the organization country through the SAME `trx`
 * (the better-sqlite3 single connection forbids a `this.db` read inside the
 * open transaction — that would deadlock the connection the trx holds). The
 * country plugin is then resolved purely in-memory via {@link PluginLoader},
 * which does not touch the database.
 */
@Injectable()
export class FixedAssetRegistrarService {
  constructor(private readonly pluginLoader: PluginLoader) {}

  async registerFromVoucher(
    trx: Kysely<Database>,
    voucher: PostedVoucher,
    expenseId: number,
  ): Promise<void> {
    // Find the capex line (a debit to a FIXED_ASSETS_* account).
    const accountIds = voucher.lines.map((l) => l.account_id);
    const accounts = await trx
      .selectFrom('account')
      .select(['id', 'code'])
      .where('id', 'in', accountIds)
      .execute();
    const codeById = new Map(accounts.map((a) => [a.id, a.code]));

    let assetClass: AssetClass | undefined;
    let costBaseMinor = 0;
    for (const line of voucher.lines) {
      const code = codeById.get(line.account_id);
      const cls = code ? assetClassForAccount(code) : undefined;
      if (cls && line.is_debit) {
        assetClass = cls;
        costBaseMinor = line.base_amount;
        break;
      }
    }
    if (!assetClass) return; // not a capex voucher

    const expense = await trx
      .selectFrom('expense')
      .select([
        'asset_name',
        'asset_useful_life_years',
        'asset_residual_value_minor',
      ])
      .where('id', '=', expenseId)
      .executeTakeFirst();

    // Resolve the active country plugin through the open `trx` (reading
    // `this.db` here would deadlock the better-sqlite3 connection the
    // transaction holds). PluginLoader.resolve is a pure in-memory lookup.
    const org = await trx
      .selectFrom('organization')
      .select('country')
      .executeTakeFirstOrThrow();
    const plugin = this.pluginLoader.resolve(org.country);
    const defaults = plugin.getFixedAssetDefaults(assetClass);

    await trx
      .insertInto('fixed_asset')
      .values({
        name: expense?.asset_name ?? `${assetClass} asset`,
        asset_class: assetClass,
        acquisition_voucher_id: voucher.id,
        acquisition_date: voucher.tax_point_date,
        cost_base_minor: costBaseMinor,
        useful_life_years:
          expense?.asset_useful_life_years ?? defaults.defaultUsefulLifeYears,
        residual_value_minor:
          expense?.asset_residual_value_minor ?? defaults.defaultResidualMinor,
        retired_at: null,
        disposal_voucher_id: null,
      })
      .execute();
  }
}
