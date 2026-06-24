import { Kysely, sql } from 'kysely';
import { Database } from '../types';

/**
 * Migration 060: add document.preview_path and expense AI classification fields.
 *
 * document.preview_path (TEXT, nullable): relative path to the rendered
 * thumbnail. NULL means "not yet rendered" and triggers the lazy fallback
 * in the triage UI (Task 4).
 *
 * expense.ai_confidence (REAL, nullable): LLM confidence score [0..1].
 * expense.ai_document_type (TEXT, nullable): e.g. 'receipt', 'invoice'.
 * expense.ai_kind (TEXT, nullable): e.g. 'expense', 'income'.
 *
 * These three fields preserve the classification facts the LLM already
 * computes but currently discards, so the Details view can display them
 * without re-invoking the model (ADR-0039).
 */
export async function up(db: Kysely<Database>): Promise<void> {
  await sql`ALTER TABLE document ADD COLUMN preview_path TEXT`.execute(db);
  await sql`ALTER TABLE expense ADD COLUMN ai_confidence REAL`.execute(db);
  await sql`ALTER TABLE expense ADD COLUMN ai_document_type TEXT`.execute(db);
  await sql`ALTER TABLE expense ADD COLUMN ai_kind TEXT`.execute(db);
}

export async function down(db: Kysely<Database>): Promise<void> {
  // SQLite cannot DROP COLUMN on tables with FKs in older versions —
  // rebuild document to remove preview_path.
  const DOC_COLS = `id, hash, filename, mime_type, size_bytes, storage_path, status, pending_triage_result, processing_since, processing_attempts, claimant_id, created_at`;
  await sql`PRAGMA foreign_keys = OFF`.execute(db);
  await sql`
    CREATE TABLE document_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hash TEXT NOT NULL UNIQUE,
      filename TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      storage_path TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      pending_triage_result TEXT,
      processing_since INTEGER,
      processing_attempts INTEGER NOT NULL DEFAULT 0,
      claimant_id INTEGER REFERENCES entity(id),
      created_at INTEGER NOT NULL
    )
  `.execute(db);
  await sql`INSERT INTO document_new (${sql.raw(DOC_COLS)}) SELECT ${sql.raw(DOC_COLS)} FROM document`.execute(
    db,
  );
  await sql`DROP TABLE document`.execute(db);
  await sql`ALTER TABLE document_new RENAME TO document`.execute(db);

  // Rebuild expense to remove the three AI columns.
  const EXP_COLS = `id, document_id, supplier_id, category, gross_amount, vat_amount, currency, tax_point_date, status, voucher_id, document_vat_marking, supplier_invoice_number, asset_name, asset_useful_life_years, asset_residual_value_minor, claimant_id, company_addressed_receipt, created_at, updated_at`;
  await sql`
    CREATE TABLE expense_new AS SELECT ${sql.raw(EXP_COLS)} FROM expense
  `.execute(db);
  await sql`DROP TABLE expense`.execute(db);
  await sql`ALTER TABLE expense_new RENAME TO expense`.execute(db);
  await sql`PRAGMA foreign_keys = ON`.execute(db);
}
