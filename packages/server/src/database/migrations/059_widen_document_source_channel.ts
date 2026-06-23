import { Kysely, sql } from 'kysely';
import { Database } from '../types';

// Columns as of migration 052 (verify against 052 before running).
const COLS = `id, document_id, channel, source_identifier, received_at, captured_at, precheck_json`;

export async function up(db: Kysely<Database>): Promise<void> {
  await sql`PRAGMA foreign_keys = OFF`.execute(db);
  await sql`
    CREATE TABLE document_source_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id INTEGER NOT NULL REFERENCES document(id) ON DELETE CASCADE,
      channel TEXT NOT NULL CHECK (channel IN (
        'upload', 'telegram', 'email', 'drive', 'ios_photo_library',
        'email_sync', 'email_push'
      )),
      source_identifier TEXT,
      received_at INTEGER NOT NULL,
      captured_at INTEGER,
      precheck_json TEXT
    )
  `.execute(db);
  await sql`INSERT INTO document_source_new (${sql.raw(COLS)}) SELECT ${sql.raw(COLS)} FROM document_source`.execute(
    db,
  );
  await sql`DROP TABLE document_source`.execute(db);
  await sql`ALTER TABLE document_source_new RENAME TO document_source`.execute(
    db,
  );
  await sql`PRAGMA foreign_keys = ON`.execute(db);
}

export async function down(db: Kysely<Database>): Promise<void> {
  await sql`PRAGMA foreign_keys = OFF`.execute(db);
  await sql`
    CREATE TABLE document_source_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id INTEGER NOT NULL REFERENCES document(id) ON DELETE CASCADE,
      channel TEXT NOT NULL CHECK (channel IN ('upload', 'telegram', 'email', 'drive', 'ios_photo_library')),
      source_identifier TEXT,
      received_at INTEGER NOT NULL,
      captured_at INTEGER,
      precheck_json TEXT
    )
  `.execute(db);
  await sql`INSERT INTO document_source_new (${sql.raw(COLS)}) SELECT ${sql.raw(COLS)} FROM document_source WHERE channel IN ('upload','telegram','email','drive','ios_photo_library')`.execute(
    db,
  );
  await sql`DROP TABLE document_source`.execute(db);
  await sql`ALTER TABLE document_source_new RENAME TO document_source`.execute(
    db,
  );
  await sql`PRAGMA foreign_keys = ON`.execute(db);
}
