import { Kysely } from 'kysely';
import { Database } from '../types';

/**
 * Issue #403: the decimal precision of the bank's PRINTED conversion rate.
 *
 * A bank that prints "0.1338333" on the statement quotes the rate to 7
 * decimals — that quoted precision is evidence of the conversion the bank
 * actually applied, and it must survive the numeric coercion (a bare double
 * cannot say how many decimals were quoted). `fx_rate_decimals` records the
 * count of decimal places in the printed rate WHEN the source presented the
 * rate as text (a CSV column or an extracted description fragment). NULL
 * means the precision is UNKNOWN — a legacy or schema-shaped numeric input
 * (a JSON `0.1338333`) carries no printed-precision information, and none is
 * fabricated for it. A derived rate (no printed rate at all) is recorded as
 * derived, not printed, at the audit layer.
 */
export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .alterTable('bank_transaction')
    .addColumn('fx_rate_decimals', 'integer')
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema
    .alterTable('bank_transaction')
    .dropColumn('fx_rate_decimals')
    .execute();
}
