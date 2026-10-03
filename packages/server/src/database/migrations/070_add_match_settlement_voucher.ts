import { Kysely } from 'kysely';
import { Database } from '../types';

/**
 * Issue #202: record the SETTLEMENT Voucher a cash match posts.
 *
 * ADR-0008 says payment is a separate settlement Voucher that clears the
 * AR/AP balance, but activation only ever flipped the link's status, so the
 * control account kept carrying receivables cash had already settled while the
 * subledger open item was reduced. Activation now posts `Dr bank / Cr AR` (or
 * `Dr AP / Cr bank`) and pins it here, so an unmatch can reverse exactly the
 * voucher its own activation posted — the same pattern `fx_voucher_id` uses.
 *
 * Nullable: matches activated BEFORE this migration have no settlement voucher
 * and none is invented for them (their cash was never in the ledger, and
 * guessing a bank account/date for a historical settlement would post an
 * unfounded entry). They are reported as unposted settlements instead, so the
 * ambiguity is visible and repairable rather than silently mixed in.
 */
export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .alterTable('reconciliation_match')
    .addColumn('settlement_voucher_id', 'integer')
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema
    .alterTable('reconciliation_match')
    .dropColumn('settlement_voucher_id')
    .execute();
}
