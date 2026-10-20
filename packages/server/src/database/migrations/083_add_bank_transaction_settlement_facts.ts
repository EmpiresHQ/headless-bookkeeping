import { Kysely } from 'kysely';
import { Database } from '../types';

/**
 * Issue #403: the settlement facts a card-conversion line carries that the
 * schema had nowhere to record.
 *
 * - `conversion_fee` — the bank's separately charged conversion fee, minor
 *   units of the line's own `currency` (the settled/account currency). A card
 *   settlement often evidences it explicitly ("conversion fee 0.08 EUR"),
 *   distinct from the purchase principal the merchant was paid;
 *   `source_amount` / `fx_rate` carry the original amount and the bank's
 *   rate, but the fee had nowhere to live: importers that knew it had to drop
 *   it, and any evidence link later had to treat the whole debit as principal,
 *   which overstates the purchase. NULLABLE, and NULL is honest — it means
 *   the statement did not evidence a fee. It is NOT a default zero: 0 is a
 *   positive assertion that the bank charged nothing (a fee-inclusive
 *   quote), and conflating the two would let an evidence check mistake "not
 *   stated" for "stated as free" (issue #403's consistency rule refuses
 *   exactly that).
 *
 * - `booking_date` — the bank's own booking date for the line, when the
 *   statement distinguishes it from the value/transaction date. NULL ≡ not
 *   distinguished (the transaction date is the only date the bank gives).
 *
 * - `bank_reference_rate` — the reference-rate OBSERVATION the bank itself
 *   prints on the line ("ECB reference rate 0.1337864 EUR/DKK"), when the
 *   statement carries it as a distinct field. Retained as EXPLICITLY
 *   UNVERIFIED evidence: it is the BANK's own report, quoted as printed, with
 *   the raw source (the statement and its description) preserved beside it —
 *   never fed into the verified ECB observation cache, never used for a
 *   statutory lookup or a valuation (ADR-0004: a bank-provided number is not
 *   verified reference-rate provenance). NULL ≡ the statement does not
 *   report one. A separate column, because keeping descriptions alone cannot
 *   cover a statement that carries the observation in its own column.
 */
export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .alterTable('bank_transaction')
    .addColumn('conversion_fee', 'integer')
    .execute();
  await db.schema
    .alterTable('bank_transaction')
    .addColumn('booking_date', 'text')
    .execute();
  await db.schema
    .alterTable('bank_transaction')
    .addColumn('bank_reference_rate', 'real')
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema
    .alterTable('bank_transaction')
    .dropColumn('bank_reference_rate')
    .execute();
  await db.schema
    .alterTable('bank_transaction')
    .dropColumn('booking_date')
    .execute();
  await db.schema
    .alterTable('bank_transaction')
    .dropColumn('conversion_fee')
    .execute();
}
