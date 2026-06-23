import { Kysely, sql } from 'kysely';
import { Database } from '../types';

/**
 * Migration 056: add expense.claimant_id and expense.company_addressed_receipt.
 *
 * claimant_id: Nullable FK to entity(id). Set when the Expense was paid by a
 * Claimant (employee or director) out of pocket. Drives CLAIMANT_PAYABLE credit
 * leg in the voucher (Task 3 / claimant-reimbursement flow).
 *
 * company_addressed_receipt: SQLite INTEGER (0/1/null). Flags whether the receipt
 * is addressed to the Organisation (true) or not (false/null). Drives VAT code
 * choice at post time: true → normal reclaim, false/null → NULL_VAT_CODE (conservative).
 */
export async function up(db: Kysely<Database>): Promise<void> {
  await sql`ALTER TABLE expense ADD COLUMN claimant_id INTEGER REFERENCES entity(id)`.execute(
    db,
  );
  await sql`ALTER TABLE expense ADD COLUMN company_addressed_receipt INTEGER`.execute(
    db,
  );
}

export async function down(db: Kysely<Database>): Promise<void> {
  // SQLite: drop columns via rebuild; prod only rolls forward.
  const COLS = `id, document_id, supplier_id, category, gross_amount, vat_amount, currency, tax_point_date, status, voucher_id, document_vat_marking, supplier_invoice_number, asset_name, asset_useful_life_years, asset_residual_value_minor, created_at, updated_at`;
  await sql`PRAGMA foreign_keys = OFF`.execute(db);
  await sql`
    CREATE TABLE expense_new AS SELECT ${sql.raw(COLS)} FROM expense
  `.execute(db);
  await sql`DROP TABLE expense`.execute(db);
  await sql`ALTER TABLE expense_new RENAME TO expense`.execute(db);
  await sql`PRAGMA foreign_keys = ON`.execute(db);
}
