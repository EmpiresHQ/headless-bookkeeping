import { Kysely, sql } from 'kysely';
import { Database } from '../types';

/**
 * Issue #399: the canonical bank-transaction journal.
 *
 * The pre-#399 model made `bank_transaction` a per-statement artifact: every
 * uploaded row inserted a new transaction owned by exactly one statement
 * (`statement_id` NOT NULL), and overlapping statement imports therefore
 * duplicated the same real-world movement. This migration separates the
 * CANONICAL movement from the IMPORT artifact, additively (legacy ids,
 * allocations, immutable vouchers and source files are never rewritten):
 *
 * - `bank_transaction` is REBUILT (the same table-rebuild pattern as
 *   migration 054, under `PRAGMA foreign_keys = OFF`) with the identity it
 *   is canonically keyed by: `account_id` (the ledger bank account),
 *   `provider_code` (the bank, as asserted by the import),
 *   `source_account_ref` (the bank's own account reference — normally the
 *   IBAN/account number the statement covers), `external_id` (the bank's
 *   own transaction id) and `archive_ref` (the bank's archive/document
 *   reference). All are nullable: a legacy or identity-poor row carries
 *   NULLs, honestly. `statement_id` becomes NULLABLE: it is the row's ORIGIN
 *   statement, and a DETACHED origin (a deleted import whose canonical
 *   movement survives — shared with another statement, or carrying
 *   financial history) leaves NULL, never a cascade delete of the movement.
 * - A partial UNIQUE index enforces canonical identity AT STORAGE LEVEL:
 *   one row per (provider_code, source_account_ref, external_id) when all
 *   three are known. A NULL in ANY of the three means the identity is
 *   UNKNOWN, and unknown identity never merges (the conservative policy —
 *   date+amount alone is not identity). The same id on a different provider
 *   or a different source account is a different movement.
 * - `bank_transaction_source` is the many-statements → one-canonical
 *   provenance link: every imported source row that resolved to a canonical
 *   transaction is recorded with its own statement, row number, per-source
 *   ids and differing per-source facts. Existing rows are backfilled with a
 *   provenance row for their origin statement.
 * - `bank_import_conflict` persists a same-identity row whose money or
 *   settlement facts conflict with the canonical row — surfaced for review,
 *   never silently overwriting it — plus `ambiguous_overlap` items where an
 *   identity-less row exactly matches a row from another source.
 * - `bank_duplicate_repair` + `bank_transaction_alias` support the audited
 *   repair of ALREADY-IMPORTED duplicates (pre-#399 rows): a repair repoints
 *   provenance, records the removed id as an alias of the survivor and is
 *   idempotent on retry (UNIQUE on both the repair pair and the alias id).
 *   The alias and repair rows deliberately carry NO FK to the removed
 *   duplicate — the duplicate row is deleted by the repair itself; the ids
 *   are historical references whose resolution is the alias table.
 * - `bank_statement.content_hash` + its UNIQUE index recognise an EXACT
 *   replay of an already-imported source (issue #399): the same file
 *   re-uploaded — renamed or row-reordered — hashes identically (the hash
 *   is computed over the SORTED, normalized row multiset), so a retry/repeat
 *   upload never inserts the journal twice, INCLUDING when the rows carry no
 *   bank transaction ids. Distinct-but-overlapping sources hash differently
 *   and are handled by the identity policy, not by pretending to be a
 *   replay. This is a SOURCE-replay identity (the import request), kept
 *   strictly separate from the MOVEMENT identity above.
 * - `bank_import_job.summary` carries the import's new/known/conflict counts
 *   to the polling UI.
 */
export async function up(db: Kysely<Database>): Promise<void> {
  // ── Statement: the import artifact's own identity inputs ──────────────
  await db.schema
    .alterTable('bank_statement')
    .addColumn('provider_code', 'text')
    .execute();
  await db.schema
    .alterTable('bank_statement')
    .addColumn('source_account_ref', 'text')
    .execute();
  // The source-replay identity (see header): hash of the normalized, sorted
  // row multiset + the import's own identity inputs. NULL for legacy rows.
  await db.schema
    .alterTable('bank_statement')
    .addColumn('content_hash', 'text')
    .execute();

  // ── Transaction rebuild: canonical identity + detachable origin ───────
  // bank_transaction has dependent FKs (reconciliation_match,
  // bank_settlement_usage, prepayment_advance), so widening statement_id to
  // nullable uses the table-rebuild pattern of migration 054.
  //
  // AUTOINCREMENT high-water mark: DROP+RENAME would reset the sequence to
  // the max SURVIVING id, reusing ids of deleted historical bank rows and
  // corrupting stable historical/audit references. The old high-water mark is
  // captured BEFORE the drop and restored after the rename (never lowered
  // below the surviving max).
  const oldSeqRows =
    await sql`SELECT seq FROM sqlite_sequence WHERE name = 'bank_transaction'`.execute(
      db,
    );
  const oldSeq = oldSeqRows.rows.length
    ? Number((oldSeqRows.rows[0] as { seq: number | bigint }).seq)
    : null;
  await sql`PRAGMA foreign_keys = OFF`.execute(db);
  await sql`
    CREATE TABLE bank_transaction_new (
      id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
      statement_id integer REFERENCES bank_statement (id),
      account_id integer,
      provider_code text,
      source_account_ref text,
      external_id text,
      archive_ref text,
      transaction_date text NOT NULL,
      description text,
      amount integer NOT NULL,
      currency text NOT NULL,
      source_currency text,
      source_amount integer,
      fx_rate real,
      conversion_fee integer,
      booking_date text,
      bank_reference_rate real,
      fx_rate_decimals integer,
      counterparty_iban text,
      counterparty_descriptor text,
      reference text,
      status text NOT NULL DEFAULT 'open'
        CHECK (status IN ('open', 'prepayment', 'personal', 'bank_fee', 'dividend')),
      created_at integer NOT NULL
    )
  `.execute(db);
  await sql`
    INSERT INTO bank_transaction_new (
      id, statement_id, transaction_date, description, amount, currency,
      source_currency, source_amount, fx_rate, conversion_fee, booking_date,
      bank_reference_rate, fx_rate_decimals, counterparty_iban,
      counterparty_descriptor, reference, status, created_at
    )
    SELECT
      id, statement_id, transaction_date, description, amount, currency,
      source_currency, source_amount, fx_rate, conversion_fee, booking_date,
      bank_reference_rate, fx_rate_decimals, counterparty_iban,
      counterparty_descriptor, reference, status, created_at
    FROM bank_transaction
  `.execute(db);
  await sql`DROP TABLE bank_transaction`.execute(db);
  await sql`ALTER TABLE bank_transaction_new RENAME TO bank_transaction`.execute(
    db,
  );
  // Restore the high-water mark (see above): ids of DELETED historical rows
  // must never be re-minted.
  await sql`
    INSERT INTO sqlite_sequence (name, seq)
    SELECT 'bank_transaction', MAX(seq)
    FROM (
      SELECT ${sql.lit(oldSeq ?? 0)} AS seq
      UNION ALL
      SELECT COALESCE(MAX(id), 0) FROM bank_transaction
    )
    WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'bank_transaction')
  `.execute(db);
  await sql`
    UPDATE sqlite_sequence
    SET seq = MAX(seq, ${sql.lit(oldSeq ?? 0)}, (SELECT COALESCE(MAX(id), 0) FROM bank_transaction))
    WHERE name = 'bank_transaction'
  `.execute(db);
  await sql`PRAGMA foreign_keys = ON`.execute(db);

  // Backfill: a legacy transaction inherits its identity inputs from its
  // (single, owning) origin statement. Legacy rows have no external_id —
  // that fact was lost before this migration — so they never merge; the
  // repair operation is the supported path for already-imported duplicates.
  await sql`
    UPDATE bank_transaction
    SET account_id = (
      SELECT s.account_id FROM bank_statement s
      WHERE s.id = bank_transaction.statement_id
    ),
    provider_code = (
      SELECT s.provider_code FROM bank_statement s
      WHERE s.id = bank_transaction.statement_id
    ),
    source_account_ref = (
      SELECT s.source_account_ref FROM bank_statement s
      WHERE s.id = bank_transaction.statement_id
    )
  `.execute(db);

  // Canonical uniqueness, enforced by the database (not a pre-insert read):
  // concurrent/retried imports of the same bank movement collide HERE.
  await sql`
    CREATE UNIQUE INDEX idx_bank_txn_canonical_identity
    ON bank_transaction (provider_code, source_account_ref, external_id)
    WHERE external_id IS NOT NULL
      AND provider_code IS NOT NULL
      AND source_account_ref IS NOT NULL
  `.execute(db);

  // Source-replay uniqueness, equally enforced at storage level: a retried /
  // concurrent re-upload of the SAME source collides HERE, whatever the
  // filename or row order.
  await sql`
    CREATE UNIQUE INDEX idx_bank_statement_content_hash
    ON bank_statement (content_hash)
    WHERE content_hash IS NOT NULL
  `.execute(db);

  // ── Many-source provenance ───────────────────────────────────────────
  await db.schema
    .createTable('bank_transaction_source')
    .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
    .addColumn('bank_transaction_id', 'integer', (col) =>
      col.notNull().references('bank_transaction.id'),
    )
    .addColumn('statement_id', 'integer', (col) =>
      col.notNull().references('bank_statement.id'),
    )
    // Row number in the source statement's own file (1-based); NULL for a
    // backfilled legacy row whose row number is unknown.
    .addColumn('source_row_number', 'integer')
    // The ids AS THIS SOURCE recorded them (may differ per source).
    .addColumn('external_id', 'text')
    .addColumn('archive_ref', 'text')
    // Per-source facts that may legitimately differ (pending vs booked
    // dates, description wording) — retained verbatim, JSON.
    .addColumn('facts', 'text')
    .addColumn('created_at', 'integer', (col) => col.notNull())
    // A statement's row is claimed once — a retry processing the same row
    // of the same statement twice collides here.
    .execute();
  await sql`
    CREATE UNIQUE INDEX idx_bank_txn_source_row
    ON bank_transaction_source (statement_id, source_row_number)
    WHERE source_row_number IS NOT NULL
  `.execute(db);

  // Backfill one provenance row per legacy transaction (its origin
  // statement), so every canonical transaction has ≥1 source.
  await sql`
    INSERT INTO bank_transaction_source
      (bank_transaction_id, statement_id, source_row_number, external_id,
       archive_ref, facts, created_at)
    SELECT id, statement_id, NULL, NULL, NULL, NULL,
      strftime('%s', 'now')
    FROM bank_transaction
  `.execute(db);

  // ── Same-identity conflicts, persisted for review ─────────────────────
  await db.schema
    .createTable('bank_import_conflict')
    .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
    .addColumn('account_id', 'integer', (col) =>
      col.notNull().references('account.id'),
    )
    .addColumn('provider_code', 'text')
    .addColumn('source_account_ref', 'text')
    .addColumn('external_id', 'text', (col) => col.notNull())
    .addColumn('canonical_transaction_id', 'integer', (col) =>
      col.notNull().references('bank_transaction.id'),
    )
    // Historical source id, like duplicate_id in the repair log below:
    // resolved conflicts outlive a detached source artifact.
    .addColumn('statement_id', 'integer', (col) => col.notNull())
    .addColumn('source_row_number', 'integer')
    // 'amount_mismatch' | 'currency_mismatch' | 'fact_mismatch' |
    // 'ambiguous_overlap' — fact_mismatch: same authoritative identity with
    // conflicting settlement/supplier facts (source amount/currency, fx
    // rate, conversion fee, counterparty IBAN) or an unexplained material
    // date change (issue #399, with #403 facts).
    .addColumn('kind', 'text', (col) =>
      col
        .notNull()
        .check(
          sql`kind IN ('amount_mismatch', 'currency_mismatch', 'fact_mismatch', 'ambiguous_overlap')`,
        ),
    )
    // JSON: { canonical: {...}, incoming: {...} } — the conflicting facts.
    .addColumn('detail', 'text', (col) => col.notNull())
    // 'open' | 'resolved' — resolved = a human disposed of it.
    .addColumn('status', 'text', (col) =>
      col
        .notNull()
        .defaultTo('open')
        .check(sql`status IN ('open', 'resolved')`),
    )
    .addColumn('created_at', 'integer', (col) => col.notNull())
    .execute();

  // ── Audited duplicate repair (pre-#399 rows) ─────────────────────────
  await db.schema
    .createTable('bank_duplicate_repair')
    .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
    // Deterministic pair key — a retried repair of the same pair collides
    // here and is recognised as already-done (idempotent).
    .addColumn('repair_key', 'text', (col) => col.notNull().unique())
    // NO FK on duplicate_id: the repair deletes the duplicate row itself;
    // the id is a historical reference the alias table resolves.
    .addColumn('survivor_id', 'integer', (col) =>
      col.notNull().references('bank_transaction.id'),
    )
    .addColumn('duplicate_id', 'integer', (col) => col.notNull())
    .addColumn('performed_by', 'text', (col) => col.notNull())
    .addColumn('created_at', 'integer', (col) => col.notNull())
    .execute();

  // Aliases: the removed duplicate's id remains resolvable to the survivor.
  // NO FK on alias_transaction_id for the same reason — the aliased row is
  // deleted by the repair; the alias IS its resolution.
  await db.schema
    .createTable('bank_transaction_alias')
    .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
    .addColumn('alias_transaction_id', 'integer', (col) =>
      col.notNull().unique(),
    )
    .addColumn('canonical_transaction_id', 'integer', (col) =>
      col.notNull().references('bank_transaction.id'),
    )
    .addColumn('repair_id', 'integer', (col) =>
      col.notNull().references('bank_duplicate_repair.id'),
    )
    .addColumn('created_at', 'integer', (col) => col.notNull())
    .execute();

  // ── Import-job summary for the polling UI ────────────────────────────
  await db.schema
    .alterTable('bank_import_job')
    .addColumn('summary', 'text')
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.alterTable('bank_import_job').dropColumn('summary').execute();
  await db.schema.dropTable('bank_transaction_alias').execute();
  await db.schema.dropTable('bank_duplicate_repair').execute();
  await db.schema.dropTable('bank_import_conflict').execute();
  await db.schema.dropTable('bank_transaction_source').execute();
  await sql`DROP INDEX IF EXISTS idx_bank_txn_canonical_identity`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_bank_statement_content_hash`.execute(db);
  await db.schema
    .alterTable('bank_transaction')
    .dropColumn('archive_ref')
    .execute();
  await db.schema
    .alterTable('bank_transaction')
    .dropColumn('external_id')
    .execute();
  await db.schema
    .alterTable('bank_transaction')
    .dropColumn('source_account_ref')
    .execute();
  await db.schema
    .alterTable('bank_transaction')
    .dropColumn('provider_code')
    .execute();
  await db.schema
    .alterTable('bank_transaction')
    .dropColumn('account_id')
    .execute();
  await db.schema
    .alterTable('bank_statement')
    .dropColumn('content_hash')
    .execute();
  await db.schema
    .alterTable('bank_statement')
    .dropColumn('source_account_ref')
    .execute();
  await db.schema
    .alterTable('bank_statement')
    .dropColumn('provider_code')
    .execute();
}
