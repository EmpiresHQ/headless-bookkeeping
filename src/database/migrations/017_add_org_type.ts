import { Kysely, sql } from 'kysely';
import { Database } from '../types';

/**
 * Migration 017: Add org_type to organization table + seed SHAREHOLDER_LOAN account.
 *
 * Per ADR-0017/ADR-0023:
 * - org_type determines the personal disposition account:
 *   sole_proprietor → OWNERS_DRAWINGS (equity contra)
 *   company → SHAREHOLDER_LOAN (receivable-from-owner, asset)
 * - Default is 'company' (v1 primary persona is a one-person company).
 */
export async function up(db: Kysely<Database>): Promise<void> {
  // Add org_type column with default 'company' and CHECK constraint.
  await db.schema
    .alterTable('organization')
    .addColumn('org_type', 'text', (col) =>
      col
        .notNull()
        .defaultTo('company')
        .check(sql`org_type IN ('company', 'sole_proprietor')`),
    )
    .execute();

  // Seed the SHAREHOLDER_LOAN account (receivable-from-owner, asset).
  // OWNERS_DRAWINGS already exists from migration 002.
  await db
    .insertInto('account')
    .values({
      code: 'SHAREHOLDER_LOAN',
      name: 'Shareholder Loan (Receivable from Owner)',
      type: 'asset',
      currency: null,
      parent_id: null,
      is_system: 1,
    })
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  // Remove the SHAREHOLDER_LOAN account.
  await db
    .deleteFrom('account')
    .where('code', '=', 'SHAREHOLDER_LOAN')
    .execute();

  // Drop the org_type column (SQLite ALTER TABLE limitations — recreate table).
  // For simplicity in down migration, we just drop the column if supported.
  // SQLite 3.35+ supports DROP COLUMN.
  await db.schema.alterTable('organization').dropColumn('org_type').execute();
}
