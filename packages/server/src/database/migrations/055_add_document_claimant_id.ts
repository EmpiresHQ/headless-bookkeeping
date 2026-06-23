import { Kysely, sql } from 'kysely';
import { Database } from '../types';

/**
 * Migration 055: add document.claimant_id.
 *
 * Nullable FK to entity(id). Set at upload time when the sender is a known
 * Claimant (role: employee | director). The IntakeQueueWorker reads this
 * and passes it to IntakeWorkflowService so channel context is not lost.
 */
export async function up(db: Kysely<Database>): Promise<void> {
  await sql`ALTER TABLE document ADD COLUMN claimant_id INTEGER REFERENCES entity(id)`.execute(db);
}

export async function down(db: Kysely<Database>): Promise<void> {
  // SQLite cannot DROP COLUMN with a FK — rebuild required.
  // In practice, down() is only used in dev; production rolls forward.
  const COLS = `id, hash, filename, mime_type, size_bytes, storage_path, status, pending_triage_result, processing_since, processing_attempts, created_at`;
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
      created_at INTEGER NOT NULL
    )
  `.execute(db);
  await sql`INSERT INTO document_new (${sql.raw(COLS)}) SELECT ${sql.raw(COLS)} FROM document`.execute(db);
  await sql`DROP TABLE document`.execute(db);
  await sql`ALTER TABLE document_new RENAME TO document`.execute(db);
  await sql`PRAGMA foreign_keys = ON`.execute(db);
}
