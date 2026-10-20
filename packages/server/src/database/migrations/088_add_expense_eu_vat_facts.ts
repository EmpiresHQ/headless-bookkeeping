import { Kysely } from 'kysely';
import { Database } from '../types';
/** Additive only: historical facts are unknown, never backfilled from supplier names. */
export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .alterTable('expense')
    .addColumn('eu_vat_facts', 'text')
    .execute();
  await db.schema
    .alterTable('voucher')
    .addColumn('vat_decision', 'text')
    .execute();
}
export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.alterTable('voucher').dropColumn('vat_decision').execute();
  await db.schema.alterTable('expense').dropColumn('eu_vat_facts').execute();
}
