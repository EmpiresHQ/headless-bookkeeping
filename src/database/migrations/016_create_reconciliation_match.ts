import { Kysely, sql } from 'kysely';
import { Database } from '../types';

/**
 * Migration 016: Create reconciliation_match table.
 *
 * N:M matching between bank transactions and vouchers.
 * match_type is CHECK-constrained to the enum values.
 */
export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .createTable('reconciliation_match')
    .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
    .addColumn('bank_transaction_id', 'integer', (col) =>
      col.notNull().references('bank_transaction.id'),
    )
    .addColumn('voucher_id', 'integer', (col) =>
      col.notNull().references('voucher.id'),
    )
    .addColumn('match_type', 'text', (col) =>
      col
        .notNull()
        .check(
          sql`match_type IN ('exact', 'partial', 'prepayment')`,
        ),
    )
    .addColumn('amount_matched', 'integer', (col) => col.notNull())
    .addColumn('created_at', 'integer', (col) => col.notNull())
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable('reconciliation_match').execute();
}
