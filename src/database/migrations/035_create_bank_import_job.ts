import { Kysely } from 'kysely';
import { Database } from '../types';

/**
 * Migration 035: Create bank_import_job table.
 *
 * Tracks async bank-statement import jobs so the UI can poll status.
 * States: 'running' → 'done' | 'failed'.
 */
export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .createTable('bank_import_job')
    .ifNotExists()
    .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
    .addColumn('status', 'text', (col) => col.notNull())
    .addColumn('account_code', 'text', (col) => col.notNull())
    .addColumn('statement_id', 'integer')
    .addColumn('error', 'text')
    .addColumn('created_at', 'integer', (col) => col.notNull())
    .addColumn('updated_at', 'integer', (col) => col.notNull())
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable('bank_import_job').ifExists().execute();
}
