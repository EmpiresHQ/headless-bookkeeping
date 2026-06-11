import { Kysely, sql } from 'kysely';
import { Database } from '../types';

/**
 * Migration 031: enforce UNIQUE(bank_transaction_id, voucher_id) on
 * reconciliation_match.
 *
 * ── The invariant ────────────────────────────────────────────────────────
 * A **ReconciliationMatch** links one bank line to one **Voucher**. The model
 * is N:M — one bank line may settle many Vouchers (a bulk payment), and one
 * Voucher may be settled by many bank lines (partial payments, ADR-0008). What
 * is NEVER legitimate is the SAME `(bank_transaction_id, voucher_id)` pair
 * appearing twice: that is not a richer match, it is a double-count that would
 * over-settle the outstanding **Receivable** / **Payable**. Until now nothing
 * stopped it — the "no duplicate / no over-match" invariant lived only in the
 * proposal-phase `min(amount, remaining)` and was unenforced at execution.
 *
 * ── Growth policy: REJECT, never silently grow a pair ──────────────────────
 * The domain DOES legitimately grow a Voucher's matched total over time (a
 * second partial payment). That growth is expressed as a *new bank line*
 * matched to the same Voucher — a distinct `(bank_transaction_id, voucher_id)`
 * pair, which this constraint allows. Re-matching the *same* bank line to the
 * *same* Voucher is never a legitimate "grow the match" operation (a single
 * bank line settles a given Voucher exactly once), so the chosen policy is to
 * REJECT the duplicate (let the UNIQUE constraint raise) rather than UPDATE the
 * existing row. The execution path re-checks the outstanding balance inside the
 * same transaction and rejects with a clear error before the INSERT, so the
 * constraint is the belt-and-braces backstop, not the primary error surface.
 *
 * No existing seed/migration/test inserts a duplicate `(bank_transaction_id,
 * voucher_id)` pair, so adding the constraint is safe for existing data.
 *
 * SQLite cannot add a table-level UNIQUE constraint to an existing table in
 * place, but a UNIQUE *index* is the equivalent enforcement and is addable
 * without a table rebuild — preferred here because reconciliation_match is
 * referenced by no FK and a rebuild would be pure ceremony.
 */
export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .createIndex('reconciliation_match_pair_unique')
    .on('reconciliation_match')
    .columns(['bank_transaction_id', 'voucher_id'])
    .unique()
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await sql`DROP INDEX IF EXISTS reconciliation_match_pair_unique`.execute(db);
}
