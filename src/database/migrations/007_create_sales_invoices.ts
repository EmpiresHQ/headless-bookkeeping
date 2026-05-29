import { Kysely, sql } from 'kysely';
import { Database } from '../types';

export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .createTable('sales_invoice')
    .ifNotExists()
    .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
    .addColumn('customer_id', 'integer')
    .addColumn('invoice_number', 'text', (col) => col.notNull().unique())
    .addColumn('gross_amount', 'integer', (col) => col.notNull())
    .addColumn('vat_amount', 'integer', (col) => col.notNull())
    .addColumn('currency', 'text', (col) => col.notNull())
    .addColumn('tax_point_date', 'text', (col) => col.notNull())
    .addColumn('due_date', 'text')
    .addColumn('status', 'text', (col) =>
      col
        .notNull()
        .defaultTo('draft')
        .check(sql`status IN ('draft', 'pending', 'posted', 'reversed')`),
    )
    .addColumn('sent_at', 'integer')
    .addColumn('voucher_id', 'integer', (col) => col.references('voucher.id'))
    .addColumn('created_at', 'integer', (col) => col.notNull())
    .addColumn('updated_at', 'integer', (col) => col.notNull())
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable('sales_invoice').ifExists().execute();
}
