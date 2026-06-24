import { Kysely, sql } from 'kysely';
import { Database } from '../types';

/**
 * Migration 062: widen `approval.object_type` to admit `allowance`.
 *
 * Allowances now flow through the approval inbox — when an operator submits
 * an allowance (draft → needs_triage), a pending Approval row is inserted.
 * The existing CHECK only permits `expense | sales_invoice | reconciliation_match`;
 * SQLite cannot ALTER a CHECK in place, so the table is rebuilt (official 12-step).
 *
 * Also copies the `policy_reason` column added in migration 043 — it must be
 * present in the rebuilt table to preserve all data.
 */
const COLUMNS = `id, object_type, object_id, status, requested_by, approved_by,
  rejected_reason, policy_reason, superseded_by, created_at, resolved_at`;

export async function up(db: Kysely<Database>): Promise<void> {
  await sql`PRAGMA foreign_keys = OFF`.execute(db);

  await sql`
    CREATE TABLE approval_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      object_type TEXT NOT NULL CHECK (object_type IN ('expense', 'sales_invoice', 'allowance', 'reconciliation_match')),
      object_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'superseded')),
      requested_by TEXT NOT NULL,
      approved_by TEXT,
      rejected_reason TEXT,
      policy_reason TEXT,
      superseded_by INTEGER REFERENCES approval(id),
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      resolved_at INTEGER
    )
  `.execute(db);

  await sql`INSERT INTO approval_new (${sql.raw(COLUMNS)}) SELECT ${sql.raw(COLUMNS)} FROM approval`.execute(
    db,
  );

  await sql`DROP TABLE approval`.execute(db);
  await sql`ALTER TABLE approval_new RENAME TO approval`.execute(db);

  await sql`PRAGMA foreign_keys = ON`.execute(db);
}

export async function down(db: Kysely<Database>): Promise<void> {
  await sql`PRAGMA foreign_keys = OFF`.execute(db);

  await sql`
    CREATE TABLE approval_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      object_type TEXT NOT NULL CHECK (object_type IN ('expense', 'sales_invoice', 'reconciliation_match')),
      object_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'superseded')),
      requested_by TEXT NOT NULL,
      approved_by TEXT,
      rejected_reason TEXT,
      policy_reason TEXT,
      superseded_by INTEGER REFERENCES approval(id),
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      resolved_at INTEGER
    )
  `.execute(db);

  // Drop any allowance approvals the narrower CHECK cannot hold.
  await sql`INSERT INTO approval_new (${sql.raw(COLUMNS)}) SELECT ${sql.raw(COLUMNS)} FROM approval WHERE object_type IN ('expense', 'sales_invoice', 'reconciliation_match')`.execute(
    db,
  );

  await sql`DROP TABLE approval`.execute(db);
  await sql`ALTER TABLE approval_new RENAME TO approval`.execute(db);

  await sql`PRAGMA foreign_keys = ON`.execute(db);
}
