import { Kysely } from 'kysely';
import { Database } from '../types';

/**
 * Issue #200: pin every filing lifecycle event to the exact FILING PAYLOAD
 * version it identifies, not just to the `vat_report` snapshot.
 *
 * `statutory_filing_snapshot` is append-only and latest-row-wins, so a later
 * reconciliation can append a corrected payload against the SAME frozen
 * `vat_report` (e.g. the declarant registry code was missing at lock). Without
 * this column, an already-`submitted` event would keep pointing at an unchanged
 * `source_snapshot_id` while the document rendered for it silently became the
 * newer payload. With it, "what we told the tax authority" stays byte-for-byte
 * reproducible per event, and every prior payload version stays addressable.
 *
 * Nullable: events recorded before this migration (and the NullCountryPlugin
 * path, which freezes no payload) carry NULL, which the export treats as "no
 * pinned version" and says so explicitly rather than guessing.
 */
export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .alterTable('statutory_submission_event')
    .addColumn('source_payload_id', 'integer')
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema
    .alterTable('statutory_submission_event')
    .dropColumn('source_payload_id')
    .execute();
}
