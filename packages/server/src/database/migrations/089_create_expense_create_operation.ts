import { Kysely } from 'kysely';
import { Database } from '../types';

/** A create receipt, not a ledger entry. Retained even after draft deletion. */
export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .createTable('expense_create_operation')
    .addColumn('operation_key', 'text', (c) => c.primaryKey())
    .addColumn('request_json', 'text', (c) => c.notNull())
    // No FK: deleting a draft must not erase/reuse its create operation.
    .addColumn('expense_id', 'integer')
    .addColumn('response_json', 'text')
    .addColumn('created_at', 'integer', (c) => c.notNull())
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable('expense_create_operation').execute();
}
