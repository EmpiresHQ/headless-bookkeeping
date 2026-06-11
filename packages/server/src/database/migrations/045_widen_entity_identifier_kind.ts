import { Kysely, sql } from 'kysely';
import { Database } from '../types';

/**
 * Migration 045: widen `entity_identifier.kind` to admit `email`, `phone`,
 * and `address`. These power multi-key supplier deduplication (a supplier with
 * no registration/VAT number is matched on email/phone instead of a fabricated
 * key). SQLite cannot alter a CHECK in place, so the table is rebuilt (official
 * 12-step). Only `entity_identifier` references `entity`; nothing references
 * `entity_identifier`, so the rebuild is local and the foreign_keys toggle is
 * safe (it is restored to ON at the end).
 */
const COLUMNS = `id, entity_id, kind, value, confirmed`;

export async function up(db: Kysely<Database>): Promise<void> {
  await sql`PRAGMA foreign_keys = OFF`.execute(db);

  await sql`
    CREATE TABLE entity_identifier_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_id INTEGER NOT NULL REFERENCES entity(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN (
        'registration_key', 'iban', 'merchant_descriptor', 'name_alias',
        'email', 'phone', 'address'
      )),
      value TEXT NOT NULL,
      confirmed INTEGER NOT NULL DEFAULT 0
    )
  `.execute(db);

  await sql`INSERT INTO entity_identifier_new (${sql.raw(COLUMNS)}) SELECT ${sql.raw(COLUMNS)} FROM entity_identifier`.execute(
    db,
  );

  await sql`DROP TABLE entity_identifier`.execute(db);
  await sql`ALTER TABLE entity_identifier_new RENAME TO entity_identifier`.execute(
    db,
  );

  await sql`PRAGMA foreign_keys = ON`.execute(db);
}

export async function down(db: Kysely<Database>): Promise<void> {
  await sql`PRAGMA foreign_keys = OFF`.execute(db);

  await sql`
    CREATE TABLE entity_identifier_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_id INTEGER NOT NULL REFERENCES entity(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN (
        'registration_key', 'iban', 'merchant_descriptor', 'name_alias'
      )),
      value TEXT NOT NULL,
      confirmed INTEGER NOT NULL DEFAULT 0
    )
  `.execute(db);

  // Drop any rows whose kind the narrow CHECK cannot hold.
  await sql`INSERT INTO entity_identifier_new (${sql.raw(COLUMNS)}) SELECT ${sql.raw(COLUMNS)} FROM entity_identifier WHERE kind IN ('registration_key', 'iban', 'merchant_descriptor', 'name_alias')`.execute(
    db,
  );

  await sql`DROP TABLE entity_identifier`.execute(db);
  await sql`ALTER TABLE entity_identifier_new RENAME TO entity_identifier`.execute(
    db,
  );

  await sql`PRAGMA foreign_keys = ON`.execute(db);
}
