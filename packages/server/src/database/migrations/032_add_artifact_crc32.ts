import { Kysely, sql } from 'kysely';
import { Database } from '../types';

/**
 * Migration 032: Add crc32 column to artifact table.
 *
 * The crc32 is an unsigned 32-bit checksum of the artifact content, used for
 * quick comparison and change detection (e.g., determining whether the
 * OCR-markdown contents have changed since the last transcription).
 *
 * Because SQLite does not support ALTER TABLE for CHECK constraints, and we
 * already recreated the artifact table in migration 026, we can safely add
 * a column here only after the artifact.kind has been widened. In practice
 * SQLite supports ADD COLUMN natively, so a simple add is sufficient.
 */
export async function up(db: Kysely<Database>): Promise<void> {
  // SQLite supports adding a nullable column directly on an existing table.
  // SQLite stores integers natively; the unsigned 32-bit value is kept as-is.
  await db.schema
    .alterTable('artifact')
    .addColumn('crc32', 'integer')
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  // SQLite does not support DROP COLUMN directly before 3.35.0.
  // Recreate the artifact table without the column and copy data.
  await db.schema
    .createTable('artifact_new')
    .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
    .addColumn('conversation_id', 'integer', (col) =>
      col.notNull().references('conversation.id'),
    )
    .addColumn('kind', 'text', (col) =>
      col
        .notNull()
        .check(
          sql`kind IN ('inbound_attachment', 'outbound_output', 'ocr_markdown')`,
        ),
    )
    .addColumn('document_id', 'integer', (col) => col.references('document.id'))
    .addColumn('storage_path', 'text', (col) => col.notNull())
    .addColumn('created_at', 'integer', (col) =>
      col.notNull().defaultTo(sql`(unixepoch())`),
    )
    .execute();

  await sql`
    INSERT INTO artifact_new (id, conversation_id, kind, document_id, storage_path, created_at)
    SELECT id, conversation_id, kind, document_id, storage_path, created_at
    FROM artifact
  `.execute(db);

  await db.schema.dropTable('artifact').execute();
  await sql`ALTER TABLE artifact_new RENAME TO artifact`.execute(db);
}
