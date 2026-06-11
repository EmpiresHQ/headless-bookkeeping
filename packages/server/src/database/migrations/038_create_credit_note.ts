import { Kysely } from 'kysely';
import { Database } from '../types';

/**
 * Migration 038: Create credit_note table.
 *
 * A credit note is a "negative invoice" that references an original
 * sales_invoice or expense (credits_object_type / credits_object_id).
 * kind: 'sales' | 'purchase'
 * status: 'draft' | 'posted' | 'reversed'
 */
export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .createTable('credit_note')
    .ifNotExists()
    .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
    .addColumn('kind', 'text', (col) => col.notNull())
    .addColumn('credits_object_type', 'text', (col) => col.notNull())
    .addColumn('credits_object_id', 'integer', (col) => col.notNull())
    .addColumn('credit_note_number', 'text', (col) => col.notNull())
    .addColumn('gross_amount', 'integer', (col) => col.notNull())
    .addColumn('vat_amount', 'integer', (col) => col.notNull())
    .addColumn('currency', 'text', (col) => col.notNull())
    .addColumn('tax_point_date', 'text', (col) => col.notNull())
    .addColumn('status', 'text', (col) => col.notNull().defaultTo('draft'))
    .addColumn('voucher_id', 'integer')
    .addColumn('created_at', 'integer', (col) => col.notNull())
    .addColumn('updated_at', 'integer', (col) => col.notNull())
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable('credit_note').ifExists().execute();
}
