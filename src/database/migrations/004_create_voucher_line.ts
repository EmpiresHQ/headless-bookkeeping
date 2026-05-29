import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
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
    .addColumn('amount', 'integer', (col) => col.notNull())
    .addColumn('currency', 'text', (col) => col.notNull())
    .addColumn('base_amount', 'integer', (col) => col.notNull())
    .addColumn('fx_rate', 'real', (col) => col.notNull())
    .addColumn('vat_code', 'text')
    .addColumn('is_debit', 'integer', (col) => col.notNull())
    .execute();

  // Enable FK enforcement for this connection (G6).
  await sql`PRAGMA foreign_keys = ON`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('voucher_line').ifExists().execute();
}
