import { Kysely, sql } from 'kysely';
import { Database } from '../types';

/**
 * Migration 064: add document.pending_triage_enrichment.
 *
 * A nullable JSON (TEXT) column that stores deterministic Pass-2 enrichment
 * separately from the strict TriageResult blob so replay/debug flows can retain
 * local AI context without widening the public triage contract.
 */
export async function up(db: Kysely<Database>): Promise<void> {
  await sql`ALTER TABLE document ADD COLUMN pending_triage_enrichment TEXT`.execute(
    db,
  );
}

export async function down(db: Kysely<Database>): Promise<void> {
  const DOC_COLS = `id, hash, filename, mime_type, size_bytes, storage_path, status, pending_triage_result, processing_since, processing_attempts, claimant_id, preview_path, created_at`;
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
      preview_path TEXT,
      created_at INTEGER NOT NULL
    )
  `.execute(db);
  await sql`INSERT INTO document_new (${sql.raw(DOC_COLS)}) SELECT ${sql.raw(DOC_COLS)} FROM document`.execute(
    db,
  );
  await sql`DROP TABLE document`.execute(db);
  await sql`ALTER TABLE document_new RENAME TO document`.execute(db);
  await sql`PRAGMA foreign_keys = ON`.execute(db);
}
