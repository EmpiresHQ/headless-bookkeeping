import { Kysely, sql } from 'kysely';
import { Database } from '../types';

/**
 * Migration 026: Add 'ocr_markdown' to artifact.kind CHECK constraint.
 *
 * SQLite does not support ALTER TABLE for CHECK constraints, so we recreate
 * the artifact table with the updated constraint.
 */
export async function up(db: Kysely<Database>): Promise<void> {
  // 1. Create new artifact table with updated CHECK.
  await db.schema
    .createTable('artifact_new')
    .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
    .addColumn('conversation_id', 'integer', (col) =>
      col.notNull().references('conversation.id'),
    )
    // enum: 'inbound_attachment' | 'outbound_output' | 'ocr_markdown'
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

  // 2. Copy existing data.
  await sql`
    INSERT INTO artifact_new (id, conversation_id, kind, document_id, storage_path, created_at)
    SELECT id, conversation_id, kind, document_id, storage_path, created_at
    FROM artifact
  `.execute(db);

  // 3. Drop old table.
  await db.schema.dropTable('artifact').execute();

  // 4. Rename new table.
  await sql`ALTER TABLE artifact_new RENAME TO artifact`.execute(db);
}

export async function down(db: Kysely<Database>): Promise<void> {
  // Reverse: recreate old table, copy data, drop new, rename.
  await db.schema
    .createTable('artifact_old')
    .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
    .addColumn('conversation_id', 'integer', (col) =>
      col.notNull().references('conversation.id'),
    )
    .addColumn('kind', 'text', (col) =>
      col
        .notNull()
        .check(sql`kind IN ('inbound_attachment', 'outbound_output')`),
    )
    .addColumn('document_id', 'integer', (col) => col.references('document.id'))
    .addColumn('storage_path', 'text', (col) => col.notNull())
    .addColumn('created_at', 'integer', (col) =>
      col.notNull().defaultTo(sql`(unixepoch())`),
    )
    .execute();

  await sql`
    INSERT INTO artifact_old (id, conversation_id, kind, document_id, storage_path, created_at)
    SELECT id, conversation_id, kind, document_id, storage_path, created_at
    FROM artifact
    WHERE kind IN ('inbound_attachment', 'outbound_output')
  `.execute(db);

  await db.schema.dropTable('artifact').execute();
  await sql`ALTER TABLE artifact_old RENAME TO artifact`.execute(db);
}
