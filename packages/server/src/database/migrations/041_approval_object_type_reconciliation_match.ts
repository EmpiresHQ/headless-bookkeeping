import { Kysely, sql } from 'kysely';
import { Database } from '../types';

/**
 * Migration 040: widen `approval.object_type` to admit `reconciliation_match`.
 *
 * Reconciliation matches now flow through the SAME approval inbox as expenses
 * and sales invoices (one queue, one human decision). The approval table's
 * `object_type` CHECK only permitted `expense` / `sales_invoice`, and SQLite
 * cannot alter a CHECK in place, so the table is rebuilt (official 12-step).
 *
 * ── Why the foreign_keys toggle is safe here ───────────────────────────────
 * The Kysely SQLite migrator runs migrations OUTSIDE a transaction
 * (`SqliteAdapter.supportsTransactionalDdl === false`), so `PRAGMA foreign_keys`
 * is honoured (it is a no-op inside a transaction). The toggle is required
 * because `approval.superseded_by` is a self-FK; only the table itself
 * references `approval`, so the rebuild is local — no other table's FK is
 * touched. foreign_keys is restored to ON at the end (matching the runtime
 * connection default in DatabaseModule).
 */
const COLUMNS = `id, object_type, object_id, status, requested_by, approved_by,
  rejected_reason, superseded_by, created_at, resolved_at`;

export async function up(db: Kysely<Database>): Promise<void> {
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
      object_type TEXT NOT NULL CHECK (object_type IN ('expense', 'sales_invoice')),
      object_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'superseded')),
      requested_by TEXT NOT NULL,
      approved_by TEXT,
      rejected_reason TEXT,
      superseded_by INTEGER REFERENCES approval(id),
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      resolved_at INTEGER
    )
  `.execute(db);

  // Drop any reconciliation_match approvals the narrow CHECK cannot hold.
  await sql`INSERT INTO approval_new (${sql.raw(COLUMNS)}) SELECT ${sql.raw(COLUMNS)} FROM approval WHERE object_type IN ('expense', 'sales_invoice')`.execute(
    db,
  );

  await sql`DROP TABLE approval`.execute(db);
  await sql`ALTER TABLE approval_new RENAME TO approval`.execute(db);

  await sql`PRAGMA foreign_keys = ON`.execute(db);
}
