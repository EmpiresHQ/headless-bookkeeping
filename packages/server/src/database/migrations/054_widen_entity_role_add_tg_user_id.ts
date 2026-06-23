import { Kysely, sql } from 'kysely';
import { Database } from '../types';

const ENTITY_COLS = `id, role, country, name, goods_vs_services, created_at, updated_at`;
const IDENT_COLS = `id, entity_id, kind, value, confirmed`;

export async function up(db: Kysely<Database>): Promise<void> {
  await sql`PRAGMA foreign_keys = OFF`.execute(db);

  // 1. Widen entity.role
  await sql`
    CREATE TABLE entity_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role TEXT NOT NULL CHECK (role IN ('supplier', 'customer', 'employee', 'director')),
      country TEXT NOT NULL,
      name TEXT NOT NULL,
      goods_vs_services TEXT CHECK (goods_vs_services IN ('goods', 'services', 'unknown')),
      created_at INTEGER,
      updated_at INTEGER
    )
  `.execute(db);
  await sql`INSERT INTO entity_new (${sql.raw(ENTITY_COLS)}) SELECT ${sql.raw(ENTITY_COLS)} FROM entity`.execute(db);
  await sql`DROP TABLE entity`.execute(db);
  await sql`ALTER TABLE entity_new RENAME TO entity`.execute(db);

  // 2. Add tg_user_id to entity_identifier.kind
  await sql`
    CREATE TABLE entity_identifier_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_id INTEGER NOT NULL REFERENCES entity(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN (
        'registration_key', 'iban', 'merchant_descriptor', 'name_alias',
        'email', 'phone', 'address', 'tg_user_id'
      )),
      value TEXT NOT NULL,
      confirmed INTEGER NOT NULL DEFAULT 0
    )
  `.execute(db);
  await sql`INSERT INTO entity_identifier_new (${sql.raw(IDENT_COLS)}) SELECT ${sql.raw(IDENT_COLS)} FROM entity_identifier`.execute(db);
  await sql`DROP TABLE entity_identifier`.execute(db);
  await sql`ALTER TABLE entity_identifier_new RENAME TO entity_identifier`.execute(db);

  await sql`PRAGMA foreign_keys = ON`.execute(db);
}

export async function down(db: Kysely<Database>): Promise<void> {
  await sql`PRAGMA foreign_keys = OFF`.execute(db);

  await sql`
    CREATE TABLE entity_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role TEXT NOT NULL CHECK (role IN ('supplier', 'customer')),
      country TEXT NOT NULL,
      name TEXT NOT NULL,
      goods_vs_services TEXT CHECK (goods_vs_services IN ('goods', 'services', 'unknown')),
      created_at INTEGER,
      updated_at INTEGER
    )
  `.execute(db);
  await sql`INSERT INTO entity_new (${sql.raw(ENTITY_COLS)}) SELECT ${sql.raw(ENTITY_COLS)} FROM entity WHERE role IN ('supplier', 'customer')`.execute(db);
  await sql`DROP TABLE entity`.execute(db);
  await sql`ALTER TABLE entity_new RENAME TO entity`.execute(db);

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
  await sql`INSERT INTO entity_identifier_new (${sql.raw(IDENT_COLS)}) SELECT ${sql.raw(IDENT_COLS)} FROM entity_identifier WHERE kind IN ('registration_key', 'iban', 'merchant_descriptor', 'name_alias', 'email', 'phone', 'address')`.execute(db);
  await sql`DROP TABLE entity_identifier`.execute(db);
  await sql`ALTER TABLE entity_identifier_new RENAME TO entity_identifier`.execute(db);

  await sql`PRAGMA foreign_keys = ON`.execute(db);
}
