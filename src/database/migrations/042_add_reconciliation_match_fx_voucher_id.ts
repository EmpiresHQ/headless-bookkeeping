import { Kysely } from 'kysely';
import { Database } from '../types';

/**
 * Migration 041: link a reconciliation match to the realized-FX voucher it
 * posted (if any), so an unmatch can reverse that voucher.
 *
 * A multi-currency settlement posts a single realized-FX voucher; until now the
 * only trace back to it was free text in the voucher's `reason`. Recording the
 * voucher id on the match makes the reversal-on-unmatch deterministic. Nullable:
 * same-currency matches post no FX voucher, and legacy rows have none.
 */
export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .alterTable('reconciliation_match')
    .addColumn('fx_voucher_id', 'integer', (col) =>
      col.references('voucher.id'),
    )
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema
    .alterTable('reconciliation_match')
    .dropColumn('fx_voucher_id')
    .execute();
}
