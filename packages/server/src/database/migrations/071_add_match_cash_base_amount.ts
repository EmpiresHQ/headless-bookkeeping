import { Kysely } from 'kysely';
import { Database } from '../types';

/**
 * Issue #202: record the CASH a match consumes, beside the booked amount it
 * settles.
 *
 * `amount_matched` is BOOKED base — the invoice's own rate. The bank line
 * carries CASH at the bank's rate. Where a foreign settlement makes the two
 * differ, the over-allocation guard was comparing one against the other: a
 * full settlement needing 9 000 of cash to clear a 9 200 receivable was
 * refused, while a line whose cash was already fully spent still admitted
 * further matches on booked headroom — duplicating money in the ledger.
 *
 * Storing the cash figure the settlement actually posted makes the guard an
 * aggregate in ONE unit, and keeps it stable afterwards: the line's free cash
 * is recomputed from what its matches took at the rates they took it at, not
 * re-derived later from rates that may have moved.
 *
 * Nullable: matches activated before this migration carry NULL. They are read
 * as having consumed their booked amount — the assumption the old guard
 * already made — so nothing is invented for them, and re-booking one through
 * the documented unmatch + re-approve repair fills it in.
 */
export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .alterTable('reconciliation_match')
    .addColumn('cash_base_amount', 'integer')
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema
    .alterTable('reconciliation_match')
    .dropColumn('cash_base_amount')
    .execute();
}
