import { Kysely, sql } from 'kysely';
import { Database } from '../types';

/**
 * ADR-0037: append-only statutory-submission event log.
 *
 * Jurisdiction-neutral log of the external statutory-filing lifecycle over an
 * immutable snapshot. One row per lifecycle event; the current filing state is
 * a fold over the events (no mutable status column). Every `submitted` event
 * pins the exact frozen source_snapshot_id (and thus the Merkle root).
 *
 * Immutability is enforced by BEFORE UPDATE/DELETE triggers (ADR-0009),
 * mirroring the vat_report and audit_log tables.
 */
export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .createTable('statutory_submission_event')
    .ifNotExists()
    .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
    .addColumn('reporting_period_id', 'integer', (col) =>
      col.notNull().references('reporting_period.id'),
    )
    .addColumn('report_kind', 'text', (col) => col.notNull())
    .addColumn('source_snapshot_type', 'text', (col) => col.notNull())
    .addColumn('source_snapshot_id', 'integer', (col) => col.notNull())
    .addColumn('event_kind', 'text', (col) => col.notNull())
    .addColumn('external_ref', 'text')
    .addColumn('occurred_at', 'integer', (col) => col.notNull())
    .addColumn('actor', 'text', (col) => col.notNull())
    .addColumn('note', 'text')
    .execute();

  // Append-only (ADR-0009): block UPDATE.
  await sql`
    CREATE TRIGGER statutory_submission_event_block_update
    BEFORE UPDATE ON statutory_submission_event
    BEGIN
      SELECT RAISE(ABORT, 'statutory_submission_event is append-only');
    END;
  `.execute(db);

  // Append-only (ADR-0009): block DELETE.
  await sql`
    CREATE TRIGGER statutory_submission_event_block_delete
    BEFORE DELETE ON statutory_submission_event
    BEGIN
      SELECT RAISE(ABORT, 'statutory_submission_event is append-only');
    END;
  `.execute(db);
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema
    .dropTable('statutory_submission_event')
    .ifExists()
    .execute();
}
