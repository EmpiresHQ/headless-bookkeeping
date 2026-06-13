import { Kysely, sql } from 'kysely';
import { Database } from '../types';

/**
 * Migration 047 (ADR-0035): the lightweight fixed-asset register.
 *
 * Master data, NOT a parallel ledger — amounts stay sourced from the ledger;
 * only depreciation parameters live here. Mutable (retired_at + disposal
 * reference are set on disposal), so it is deliberately NOT append-only.
 *
 * Also adds 3 nullable asset-intake columns to `expense`: the asset name and
 * the optional useful-life / residual overrides the operator supplies when
 * categorizing a purchase as a fixed asset. NULL on a non-capex expense.
 */
export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .createTable('fixed_asset')
    .ifNotExists()
    .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
    .addColumn('name', 'text', (col) => col.notNull())
    .addColumn('asset_class', 'text', (col) =>
      col
        .notNull()
        .check(
          sql`asset_class IN ('vehicle','it_equipment','machinery','furniture')`,
        ),
    )
    .addColumn('acquisition_voucher_id', 'integer', (col) =>
      col.notNull().references('voucher.id'),
    )
    .addColumn('acquisition_date', 'text', (col) => col.notNull())
    .addColumn('cost_base_minor', 'integer', (col) => col.notNull())
    .addColumn('useful_life_years', 'integer', (col) => col.notNull())
    .addColumn('residual_value_minor', 'integer', (col) => col.notNull())
    .addColumn('retired_at', 'integer')
    .addColumn('disposal_voucher_id', 'integer', (col) =>
      col.references('voucher.id'),
    )
    .execute();

  await db.schema
    .alterTable('expense')
    .addColumn('asset_name', 'text')
    .execute();
  await db.schema
    .alterTable('expense')
    .addColumn('asset_useful_life_years', 'integer')
    .execute();
  await db.schema
    .alterTable('expense')
    .addColumn('asset_residual_value_minor', 'integer')
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.alterTable('expense').dropColumn('asset_name').execute();
  await db.schema
    .alterTable('expense')
    .dropColumn('asset_useful_life_years')
    .execute();
  await db.schema
    .alterTable('expense')
    .dropColumn('asset_residual_value_minor')
    .execute();
  await db.schema.dropTable('fixed_asset').ifExists().execute();
}
