import { Kysely, sql } from 'kysely';
import { Database } from '../types';

export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .createTable('expense')
    .ifNotExists()
    .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
    .addColumn('document_id', 'integer')
    .addColumn('supplier_id', 'integer')
    .addColumn('category', 'text', (col) => col.notNull())
    .addColumn('gross_amount', 'integer', (col) => col.notNull())
    .addColumn('vat_amount', 'integer', (col) => col.notNull())
    .addColumn('currency', 'text', (col) => col.notNull())
    .addColumn('tax_point_date', 'text', (col) => col.notNull())
    .addColumn('status', 'text', (col) =>
      col
        .notNull()
        .check(sql`status IN ('draft', 'pending', 'posted', 'reversed')`),
    )
    .addColumn('voucher_id', 'integer')
    .addColumn('created_at', 'integer', (col) =>
      col.notNull().defaultTo(sql`(unixepoch())`),
    )
    .addColumn('updated_at', 'integer', (col) =>
      col.notNull().defaultTo(sql`(unixepoch())`),
    )
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable('expense').ifExists().execute();
}
