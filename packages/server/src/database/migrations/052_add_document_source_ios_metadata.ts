import { Kysely, sql } from 'kysely';
import { Database } from '../types';

/**
 * Adds iOS provenance columns (`captured_at`, `precheck_json`) to
 * `document_source` and widens the `channel` CHECK constraint to allow
 * `'ios_photo_library'`.
 *
 * SQLite cannot ALTER a CHECK constraint in place, so the table is rebuilt
 * (create new → copy → drop → rename). No other table references
 * `document_source`, so the rebuild is safe.
 */
export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .createTable('document_source_new')
    .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
    .addColumn('document_id', 'integer', (col) =>
      col.notNull().references('document.id'),
    )
    .addColumn('channel', 'text', (col) =>
      col
        .notNull()
        .check(
          sql`channel IN ('upload', 'telegram', 'email', 'drive', 'ios_photo_library')`,
        ),
    )
    .addColumn('source_identifier', 'text')
    .addColumn('received_at', 'integer', (col) =>
      col.notNull().defaultTo(sql`(unixepoch())`),
    )
    .addColumn('captured_at', 'integer')
    .addColumn('precheck_json', 'text')
    .execute();

  await sql`
    INSERT INTO document_source_new
      (id, document_id, channel, source_identifier, received_at)
    SELECT id, document_id, channel, source_identifier, received_at
    FROM document_source
  `.execute(db);

  await db.schema.dropTable('document_source').execute();
  await sql`ALTER TABLE document_source_new RENAME TO document_source`.execute(
    db,
  );
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema
    .createTable('document_source_old')
    .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
    .addColumn('document_id', 'integer', (col) =>
      col.notNull().references('document.id'),
    )
    .addColumn('channel', 'text', (col) =>
      col
        .notNull()
        .check(sql`channel IN ('upload', 'telegram', 'email', 'drive')`),
    )
    .addColumn('source_identifier', 'text')
    .addColumn('received_at', 'integer', (col) =>
      col.notNull().defaultTo(sql`(unixepoch())`),
    )
    .execute();

  await sql`
    INSERT INTO document_source_old
      (id, document_id, channel, source_identifier, received_at)
    SELECT id, document_id, channel, source_identifier, received_at
    FROM document_source
  `.execute(db);

  await db.schema.dropTable('document_source').execute();
  await sql`ALTER TABLE document_source_old RENAME TO document_source`.execute(
    db,
  );
}
