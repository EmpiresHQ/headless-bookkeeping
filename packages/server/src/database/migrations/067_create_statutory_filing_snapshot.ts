import { Kysely, sql } from 'kysely';
import { Database } from '../types';

/**
 * Issue #200: freeze the COMPLETE filing state a period is filed against.
 *
 * `vat_report` freezes the VAT boxes, the covered voucher ids and their Merkle
 * root — but a KMD filing is more than that: it also carries the declarant
 * identity, the signed taxable bases of the declaration, and the per-document
 * INF lines (counterparty names, registration keys, invoice numbers). All of
 * those were previously recomputed from MUTABLE current data at export time, so
 * a final export could silently disagree with what was actually filed once an
 * entity was renamed or the organization's registry code changed.
 *
 * One row = one frozen `StatutoryReportInput` bound to one frozen `vat_report`.
 * Append-only (ADR-0009 pattern): a correction never edits a row, it appends a
 * newer one for the same `vat_report_id`. WHICH version an export renders is
 * decided by the `statutory_submission_event` that pins it (migration 068), not
 * by recency — so appending a corrected payload can never retroactively change
 * what an already-submitted event identifies. The newest row is only the
 * fallback for events recorded before that column existed.
 *
 * Periods locked before this migration simply have no row. The final export
 * then REFUSES rather than passing a reconstruction off as the filed state;
 * `POST /api/reporting-periods/:id/filing/reconcile` freezes one.
 */
export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .createTable('statutory_filing_snapshot')
    .ifNotExists()
    .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
    .addColumn('reporting_period_id', 'integer', (col) =>
      col.notNull().references('reporting_period.id'),
    )
    .addColumn('vat_report_id', 'integer', (col) =>
      col.notNull().references('vat_report.id'),
    )
    .addColumn('report_kind', 'text', (col) => col.notNull())
    // The jurisdiction whose country plugin RENDERED this filing. Frozen with
    // the payload: `organization.country` is mutable, and resolving the plugin
    // from it at export time would let a later country change silently alter —
    // or, via NullCountryPlugin, silently empty — an already-filed artifact.
    .addColumn('country', 'text', (col) => col.notNull())
    // JSON string: the frozen StatutoryReportInput (declarant, declaration,
    // boxes, totals, INF sales/purchase lines).
    .addColumn('payload', 'text', (col) => col.notNull())
    // Why this row exists: 'lock' | 'reconcile'.
    .addColumn('reason', 'text', (col) => col.notNull())
    .addColumn('created_at', 'integer', (col) => col.notNull())
    .execute();

  await db.schema
    .createIndex('idx_statutory_filing_snapshot_vat_report')
    .ifNotExists()
    .on('statutory_filing_snapshot')
    .columns(['vat_report_id', 'id'])
    .execute();

  // Append-only (ADR-0009): block UPDATE.
  await sql`
    CREATE TRIGGER statutory_filing_snapshot_block_update
    BEFORE UPDATE ON statutory_filing_snapshot
    BEGIN
      SELECT RAISE(ABORT, 'statutory_filing_snapshot is append-only');
    END;
  `.execute(db);

  // Append-only (ADR-0009): block DELETE.
  await sql`
    CREATE TRIGGER statutory_filing_snapshot_block_delete
    BEFORE DELETE ON statutory_filing_snapshot
    BEGIN
      SELECT RAISE(ABORT, 'statutory_filing_snapshot is append-only');
    END;
  `.execute(db);
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable('statutory_filing_snapshot').ifExists().execute();
}
