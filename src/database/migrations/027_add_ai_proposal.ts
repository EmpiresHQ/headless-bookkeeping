import { Kysely, sql } from 'kysely';
import { Database } from '../types';

/**
 * Migration 027: Create ai_proposal table for AI provenance audit trail.
 *
 * This is an operational audit table — NOT part of the hash-chained ledger.
 * Stores the raw AI proposal metadata (model, confidence, triage result)
 * for every AI-driven posting attempt.
 */
export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .createTable('ai_proposal')
    .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
    .addColumn('business_object_type', 'text', (col) => col.notNull())
    .addColumn('business_object_id', 'integer', (col) => col.notNull())
    .addColumn('model_id', 'text')
    .addColumn('model_version', 'text')
    .addColumn('raw_triage_result', 'text')
    .addColumn('ocr_artifact_id', 'integer', (col) =>
      col.references('artifact.id'),
    )
    .addColumn('confidence', 'real')
    .addColumn('created_at', 'integer', (col) =>
      col.notNull().defaultTo(sql`(unixepoch())`),
    )
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable('ai_proposal').execute();
}
