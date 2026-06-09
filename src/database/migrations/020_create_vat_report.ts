import { Kysely, sql } from 'kysely';
import { Database } from '../types';

/**
 * Task 28: VAT report snapshot table.
 *
 * An immutable snapshot generated when a reporting period is locked.
 * Aggregates all vouchers whose tax_point_date falls within the period,
 * grouped by VAT code into input vs output totals.
 *
 * Immutability is enforced by BEFORE UPDATE/DELETE triggers (ADR-0009).
 */
export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .createTable('vat_report')
    .ifNotExists()
    .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
    .addColumn('reporting_period_id', 'integer', (col) =>
      col.notNull().references('reporting_period.id'),
    )
    .addColumn('period_name', 'text', (col) => col.notNull())
    .addColumn('start_date', 'text', (col) => col.notNull())
    .addColumn('end_date', 'text', (col) => col.notNull())
    .addColumn('vat_summary', 'text', (col) => col.notNull())
    .addColumn('total_input_vat', 'integer', (col) => col.notNull())
    .addColumn('total_output_vat', 'integer', (col) => col.notNull())
    .addColumn('total_payable', 'integer', (col) => col.notNull())
    .addColumn('total_receivable', 'integer', (col) => col.notNull())
    .addColumn('voucher_ids', 'text', (col) => col.notNull())
    .addColumn('merkle_root', 'text')
    .addColumn('generated_at', 'integer', (col) => col.notNull())
    .execute();

  // Immutability: VAT report snapshot can never be updated (ADR-0009).
  await sql`
    CREATE TRIGGER vat_report_block_update
    BEFORE UPDATE ON vat_report
    BEGIN
      SELECT RAISE(ABORT, 'VAT report is immutable');
    END;
  `.execute(db);

  // Immutability: VAT report snapshot can never be deleted (ADR-0009).
  await sql`
    CREATE TRIGGER vat_report_block_delete
    BEFORE DELETE ON vat_report
    BEGIN
      SELECT RAISE(ABORT, 'VAT report is immutable');
    END;
  `.execute(db);
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable('vat_report').ifExists().execute();
}
