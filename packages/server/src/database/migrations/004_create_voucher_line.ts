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
    .addColumn('amount', 'integer', (col) =>
      col.notNull().check(sql`amount > 0`),
    )
    .addColumn('currency', 'text', (col) => col.notNull())
    .addColumn('base_amount', 'integer', (col) =>
      col.notNull().check(sql`base_amount > 0`),
    )
    .addColumn('fx_rate', 'real', (col) =>
      col.notNull().check(sql`fx_rate > 0`),
    )
    .addColumn('vat_code', 'text')
    .addColumn('is_debit', 'integer', (col) =>
      col.notNull().check(sql`is_debit IN (0, 1)`),
    )
    .execute();

  // A line of a POSTED voucher is immutable (ADR-0019). The parent's posted_at
  // is looked up via the line's voucher_id.
  await sql`
    CREATE TRIGGER voucher_line_block_update_when_posted
    BEFORE UPDATE ON voucher_line
    WHEN (SELECT posted_at FROM voucher WHERE id = OLD.voucher_id) IS NOT NULL
    BEGIN
      SELECT RAISE(ABORT, 'posted voucher line is immutable (ADR-0019)');
    END;
  `.execute(db);

  await sql`
    CREATE TRIGGER voucher_line_block_delete_when_posted
    BEFORE DELETE ON voucher_line
    WHEN (SELECT posted_at FROM voucher WHERE id = OLD.voucher_id) IS NOT NULL
    BEGIN
      SELECT RAISE(ABORT, 'posted voucher line is immutable (ADR-0019)');
    END;
  `.execute(db);
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable('voucher_line').ifExists().execute();
}
