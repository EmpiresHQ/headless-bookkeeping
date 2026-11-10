import { Kysely } from 'kysely';
import { Database } from '../types';

/**
 * Persist a successful bank-CSV column mapping, keyed by the account and the
 * export format's header signature. Uploads from the same bank with the same
 * export format then apply the stored ruleset deterministically instead of
 * asking the LLM again (the production incident: a non-deterministic
 * `fx_rate` inference broke an otherwise-repeatable import).
 *
 * The profile is only written after an import has succeeded; a ruleset that
 * failed validation or application is never cached.
 */
export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .createTable('bank_mapping_profile')
    .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
    .addColumn('account_code', 'text', (col) => col.notNull())
    .addColumn('header_hash', 'text', (col) => col.notNull())
    // The header names, for humans/debugging. The hash is the key.
    .addColumn('header_json', 'text', (col) => col.notNull())
    .addColumn('ruleset_json', 'text', (col) => col.notNull())
    // The import job that produced the profile; NULL for an operator seed.
    .addColumn('source_job_id', 'integer')
    .addColumn('created_at', 'integer', (col) => col.notNull())
    .addColumn('last_used_at', 'integer', (col) => col.notNull())
    .execute();

  // One mapping per (account, export format).
  await db.schema
    .createIndex('bank_mapping_profile_account_header_unique')
    .on('bank_mapping_profile')
    .columns(['account_code', 'header_hash'])
    .unique()
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema
    .dropIndex('bank_mapping_profile_account_header_unique')
    .ifExists()
    .execute();
  await db.schema.dropTable('bank_mapping_profile').ifExists().execute();
}
