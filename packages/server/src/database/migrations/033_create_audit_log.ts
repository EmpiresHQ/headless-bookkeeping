// src/database/migrations/033_create_audit_log.ts
import { Kysely, sql } from 'kysely';
import { Database } from '../types';

export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .createTable('audit_log')
    .addColumn('id', 'integer', (col) => col.autoIncrement().primaryKey())
    .addColumn('occurred_at', 'integer', (col) => col.notNull())
    .addColumn('actor', 'text', (col) => col.notNull())
    .addColumn('action', 'text', (col) => col.notNull())
    .addColumn('target_type', 'text')
    .addColumn('target_id', 'integer')
    .addColumn('outcome', 'text', (col) => col.notNull())
    .addColumn('detail', 'text')
    .execute();

  // Append-only: posted-voucher-style immutability (ADR-0026 — NOT hash-chained).
  await sql`
    CREATE TRIGGER audit_log_no_update
    BEFORE UPDATE ON audit_log
    BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
  `.execute(db);
  await sql`
    CREATE TRIGGER audit_log_no_delete
    BEFORE DELETE ON audit_log
    BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
  `.execute(db);
}

export async function down(db: Kysely<Database>): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS audit_log_no_update`.execute(db);
  await sql`DROP TRIGGER IF EXISTS audit_log_no_delete`.execute(db);
  await db.schema.dropTable('audit_log').execute();
}
