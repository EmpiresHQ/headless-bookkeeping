import { Kysely, sql } from 'kysely';
import { Database } from '../types';

export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .createTable('voucher_line')
    .ifNotExists()
    .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
    .addColumn('voucher_id', 'integer', (col) =>
      col.notNull().references('voucher.id'),
    )
    .addColumn('account_id', 'integer', (col) =>
      col.notNull().references('account.id'),
    )
    .addColumn('amount', 'integer', (col) => col.notNull().check(sql`amount > 0`))
    .addColumn('currency', 'text', (col) => col.notNull())
    .addColumn('base_amount', 'integer', (col) =>
      col.notNull().check(sql`base_amount > 0`),
    )
    .addColumn('fx_rate', 'real', (col) => col.notNull().check(sql`fx_rate > 0`))
    .addColumn('vat_code', 'text')
    .addColumn('is_debit', 'integer', (col) =>
      col.notNull().check(sql`is_debit IN (0, 1)`),
    )
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable('voucher_line').ifExists().execute();
}
