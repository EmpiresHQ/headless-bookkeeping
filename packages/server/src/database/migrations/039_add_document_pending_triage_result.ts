import { Kysely } from 'kysely';
import { Database } from '../types';

/**
 * Migration 039: Add document.pending_triage_result.
 *
 * A nullable JSON (TEXT) column that holds the JSON-stringified TriageResult
 * which blocked a document on the `supplier-unresolved` route (Task 43). It is
 * set when the intake workflow parks the document in `needs_triage` for that
 * reason, and cleared (NULL) when the document leaves needs_triage (resolved to
 * `triaged`, or dismissed to `processed`). NULL for every other state/reason.
 */
export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .alterTable('document')
    .addColumn('pending_triage_result', 'text')
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema
    .alterTable('document')
    .dropColumn('pending_triage_result')
    .execute();
}
