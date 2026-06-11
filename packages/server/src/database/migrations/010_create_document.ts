import { Kysely, sql } from 'kysely';
import { Database } from '../types';

export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .createTable('document')
    .ifNotExists()
    .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
    // SHA-256 of the file content; the deduplication anchor (ADR-0010).
    .addColumn('hash', 'text', (col) => col.notNull().unique())
    .addColumn('filename', 'text', (col) => col.notNull())
    .addColumn('mime_type', 'text', (col) => col.notNull())
    .addColumn('size_bytes', 'integer', (col) => col.notNull())
    // Filesystem path relative to the storage root; set after the file is saved.
    .addColumn('storage_path', 'text')
    // enum: 'pending' | 'triaged' | 'processed' | 'error'
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

  await db.schema
    .createTable('document_source')
    .ifNotExists()
    .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
    .addColumn('document_id', 'integer', (col) =>
      col.notNull().references('document.id'),
    )
    // enum: 'upload' | 'telegram' | 'email' | 'drive'
    .addColumn('channel', 'text', (col) =>
      col
        .notNull()
        .check(sql`channel IN ('upload', 'telegram', 'email', 'drive')`),
    )
    // Channel-specific identifier (e.g. Telegram message id, email Message-Id).
    .addColumn('source_identifier', 'text')
    .addColumn('received_at', 'integer', (col) =>
      col.notNull().defaultTo(sql`(unixepoch())`),
    )
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable('document_source').ifExists().execute();
  await db.schema.dropTable('document').ifExists().execute();
}
