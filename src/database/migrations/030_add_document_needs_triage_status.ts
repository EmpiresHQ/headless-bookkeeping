import { Kysely, sql } from 'kysely';
import { Database } from '../types';

/**
 * Widen the Document status CHECK to admit 'needs_triage' (ADR-0024).
 *
 * The intake workflow is now the single deep owner of "Document -> outcome"
 * and owns the Document status transition itself. A Document routed to a human
 * (AuditFinding(needs_triage)) now lands in its own status `needs_triage`
 * rather than being conflated with `triaged` (a confident draft). This makes
 * an idempotent re-run a guarded, observable no-op.
 *
 * SQLite cannot ALTER a CHECK constraint in place, so we rebuild the column's
 * constraint via the documented table-rebuild dance. The `document` table is
 * referenced by `document_source` (FK), so we drop/recreate that FK as well by
 * disabling foreign-key enforcement for the duration of the rebuild.
 *
 * Status machine: pending -> triaged | needs_triage; triaged -> processed;
 * needs_triage -> triaged. (`error` retained for transport/parse failures.)
 */
export async function up(db: Kysely<Database>): Promise<void> {
  // Rebuild `document` with the widened CHECK. We copy rows into a new table,
  // drop the old, and rename — the canonical SQLite "change a constraint" path.
  await sql`PRAGMA foreign_keys = OFF`.execute(db);

  await db.schema
    .createTable('document_new')
    .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
    .addColumn('hash', 'text', (col) => col.notNull().unique())
    .addColumn('filename', 'text', (col) => col.notNull())
    .addColumn('mime_type', 'text', (col) => col.notNull())
    .addColumn('size_bytes', 'integer', (col) => col.notNull())
    .addColumn('storage_path', 'text')
    .addColumn('status', 'text', (col) =>
      col
        .notNull()
        .defaultTo('pending')
        .check(
          sql`status IN ('pending', 'triaged', 'needs_triage', 'processed', 'error')`,
        ),
    )
    .addColumn('created_at', 'integer', (col) =>
      col.notNull().defaultTo(sql`(unixepoch())`),
    )
    .execute();

  await sql`
    INSERT INTO document_new (id, hash, filename, mime_type, size_bytes, storage_path, status, created_at)
    SELECT id, hash, filename, mime_type, size_bytes, storage_path, status, created_at FROM document
  `.execute(db);

  await db.schema.dropTable('document').execute();
  await sql`ALTER TABLE document_new RENAME TO document`.execute(db);

  await sql`PRAGMA foreign_keys = ON`.execute(db);
}

export async function down(db: Kysely<Database>): Promise<void> {
  await sql`PRAGMA foreign_keys = OFF`.execute(db);

  await db.schema
    .createTable('document_old')
    .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
    .addColumn('hash', 'text', (col) => col.notNull().unique())
    .addColumn('filename', 'text', (col) => col.notNull())
    .addColumn('mime_type', 'text', (col) => col.notNull())
    .addColumn('size_bytes', 'integer', (col) => col.notNull())
    .addColumn('storage_path', 'text')
    .addColumn('status', 'text', (col) =>
      col
        .notNull()
        .defaultTo('pending')
        .check(sql`status IN ('pending', 'triaged', 'processed', 'error')`),
    )
    .addColumn('created_at', 'integer', (col) =>
      col.notNull().defaultTo(sql`(unixepoch())`),
    )
    .execute();

  // Collapse any needs_triage rows back to triaged so the narrower CHECK holds.
  await sql`
    INSERT INTO document_old (id, hash, filename, mime_type, size_bytes, storage_path, status, created_at)
    SELECT id, hash, filename, mime_type, size_bytes, storage_path,
           CASE WHEN status = 'needs_triage' THEN 'triaged' ELSE status END,
           created_at FROM document
  `.execute(db);

  await db.schema.dropTable('document').execute();
  await sql`ALTER TABLE document_old RENAME TO document`.execute(db);

  await sql`PRAGMA foreign_keys = ON`.execute(db);
}
