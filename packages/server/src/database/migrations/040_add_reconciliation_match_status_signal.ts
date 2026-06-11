import { Kysely, sql } from 'kysely';
import { Database } from '../types';

/**
 * Migration 039: stage reconciliation matches behind approval + record provenance.
 *
 * ── `status` (draft | active) ──────────────────────────────────────────────
 * A **ReconciliationMatch** no longer takes effect the instant it is recorded.
 * It is created as `draft` and only counts toward a Voucher's settled total once
 * a human (or the idempotent auto-stage gate) promotes it to `active` through an
 * Approval. The remaining-balance maths nets only `active` matches, so a draft
 * never silently settles an outstanding **Receivable** / **Payable**.
 *
 * Existing rows predate the gate and are already live, so they default to
 * `active` — the migration is behaviour-preserving for pre-existing data.
 *
 * ── `signal` (provenance) ──────────────────────────────────────────────────
 * Which signal produced the match — `invoice_number` / `counterparty` /
 * `amount_date` / `manual`. Nullable (legacy rows have no recorded provenance).
 * The value is informational only; it is never part of the settlement maths.
 */
export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .alterTable('reconciliation_match')
    .addColumn('status', 'text', (col) =>
      col
        .notNull()
        .defaultTo('active')
        .check(sql`status IN ('draft', 'active')`),
    )
    .execute();

  await db.schema
    .alterTable('reconciliation_match')
    .addColumn('signal', 'text')
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema
    .alterTable('reconciliation_match')
    .dropColumn('signal')
    .execute();
  await db.schema
    .alterTable('reconciliation_match')
    .dropColumn('status')
    .execute();
}
