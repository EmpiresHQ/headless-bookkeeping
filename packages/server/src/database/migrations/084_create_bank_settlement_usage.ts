import { Kysely } from 'kysely';
import { Database } from '../types';

/**
 * Issue #403: a DB-level claim of which expense a bank settlement line
 * evidences.
 *
 * The bank-settlement FX valuation is exclusive: ONE bank line values ONE
 * purchase. Enforcing that with a pre-read of audit_log (read-then-write) was
 * a TOCTOU race — two expenses generating drafts concurrently could both link
 * the same bank line and both post against it. This table makes the claim
 * ATOMIC: `bank_transaction_id` is UNIQUE, so a second claim by a different
 * expense fails at the database level, whatever the interleaving. The claim is
 * keyed to the EXPENSE (not the voucher): an expense holds its evidence from
 * the first successful draft generation (idempotent re-generation, retry and
 * approval replay keep the same claim) until the ledger lifecycle reclaims it
 * (deferred with the canonical journal, issue #399).
 *
 * The row is deliberately NOT the human-readable audit trail (that stays in
 * audit_log's `expense.bank_settlement_fx` entry, written once per expense);
 * it is the machine-readable exclusivity guard.
 */
export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .createTable('bank_settlement_usage')
    .addColumn('bank_transaction_id', 'integer', (col) =>
      col
        .notNull()
        .unique()
        .references('bank_transaction.id')
        .onDelete('cascade'),
    )
    .addColumn('expense_id', 'integer', (col) =>
      col.notNull().references('expense.id').onDelete('cascade'),
    )
    .addColumn('created_at', 'integer', (col) => col.notNull())
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable('bank_settlement_usage').execute();
}
