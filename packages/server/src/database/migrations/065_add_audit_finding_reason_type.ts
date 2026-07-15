import { Kysely } from 'kysely';
import { Database } from '../types';

/**
 * Migration 065: persist the triage reason_type on audit_finding at write time
 * instead of re-deriving it from the free-text description on every read
 * (the string-sniffing that mislabeled Pass-2 failures as ocr_failed).
 * Nullable: only meaningful for needs_triage findings; legacy rows stay NULL
 * and fall back to classifyReasonType(description) at read time.
 */
export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .alterTable('audit_finding')
    .addColumn('reason_type', 'text')
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema
    .alterTable('audit_finding')
    .dropColumn('reason_type')
    .execute();
}
