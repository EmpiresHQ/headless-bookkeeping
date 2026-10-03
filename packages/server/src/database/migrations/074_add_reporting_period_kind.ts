import { Kysely, sql } from 'kysely';
import { Database } from '../types';

/**
 * Two timelines, one table (issue #207).
 *
 * `reporting_period.kind` splits the single period timeline into the VAT
 * calendar (`vat`) and the independent financial-year scope (`annual`). Every
 * pre-existing row is a VAT period — that is what they have always been — so
 * the column defaults to `vat` and existing ids, locks, `filed_at` stamps and
 * `vat_report_snapshot_id` bindings keep their exact meaning.
 *
 * `voucher.annual_close_period_id` is the TRUSTED mark of a year-end
 * adjustment: it is written only by the narrowly validated annual-close posting
 * path (PostingService + PeriodLockService), never from a request payload, and
 * it is what lets a VAT snapshot exclude an adjustment posted after the month
 * was filed instead of drifting away from its frozen figures. The voucher hash
 * chain (ADR-0013) commits to a FIXED field list, so adding the column leaves
 * every existing hash unchanged.
 */
export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .alterTable('reporting_period')
    .addColumn('kind', 'text', (col) => col.notNull().defaultTo('vat'))
    .execute();

  // Explicit backfill: a `defaultTo` on ALTER TABLE already fills existing rows
  // in SQLite, but stating it makes the intent (legacy period == VAT period)
  // independent of that dialect detail.
  await sql`UPDATE reporting_period SET kind = 'vat' WHERE kind IS NULL`.execute(
    db,
  );

  await db.schema
    .alterTable('voucher')
    .addColumn('annual_close_period_id', 'integer')
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema
    .alterTable('voucher')
    .dropColumn('annual_close_period_id')
    .execute();
  await db.schema.alterTable('reporting_period').dropColumn('kind').execute();
}
