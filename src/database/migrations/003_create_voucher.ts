import { Kysely, sql } from 'kysely';
import { Database } from '../types';

export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .createTable('voucher')
    .ifNotExists()
    .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
    .addColumn('voucher_number', 'text', (col) => col.notNull().unique())
    .addColumn('tax_point_date', 'text', (col) => col.notNull())
    .addColumn('posted_at', 'integer')
    .addColumn('previous_hash', 'text')
    .addColumn('reverses_id', 'integer', (col) => col.references('voucher.id'))
    .addColumn('corrects_object_type', 'text')
    .addColumn('corrects_object_id', 'integer')
    .addColumn('reason', 'text')
    .execute();

  // Immutability backstop (ADR-0019): a posted voucher can never be updated or
  // deleted by ANY write path. Gated on OLD.posted_at so the Wave-3 Policy-hold
  // path (insert unposted -> later set posted_at) is still allowed.
  await sql`
    CREATE TRIGGER voucher_block_update_when_posted
    BEFORE UPDATE ON voucher
    WHEN OLD.posted_at IS NOT NULL
    BEGIN
      SELECT RAISE(ABORT, 'posted voucher is immutable (ADR-0019)');
    END;
  `.execute(db);

  await sql`
    CREATE TRIGGER voucher_block_delete_when_posted
    BEFORE DELETE ON voucher
    WHEN OLD.posted_at IS NOT NULL
    BEGIN
      SELECT RAISE(ABORT, 'posted voucher is immutable (ADR-0019)');
    END;
  `.execute(db);
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable('voucher').ifExists().execute();
}
