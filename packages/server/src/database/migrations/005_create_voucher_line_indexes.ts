import { Kysely } from 'kysely';
import { Database } from '../types';

export async function up(db: Kysely<Database>): Promise<void> {
  // SQLite does not auto-index foreign keys; the append-only voucher_line
  // table will otherwise full-scan on every lookup by voucher_id or account_id.
  await db.schema
    .createIndex('idx_voucher_line_voucher_id')
    .on('voucher_line')
    .column('voucher_id')
    .execute();

  await db.schema
    .createIndex('idx_voucher_line_account_id')
    .on('voucher_line')
    .column('account_id')
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropIndex('idx_voucher_line_voucher_id').execute();
  await db.schema.dropIndex('idx_voucher_line_account_id').execute();
}
