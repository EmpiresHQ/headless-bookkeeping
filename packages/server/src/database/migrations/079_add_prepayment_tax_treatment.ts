import { Kysely, sql } from 'kysely';
import { Database } from '../types';

/**
 * The tax facts a customer advance turns on (issue #213).
 *
 * Estonian VAT arises on the EARLIER of the supply and the payment for it
 * (KMS §11 lg 1; EMTA, general time-of-supply rule). A payment received for an
 * identified taxable supply therefore creates taxable turnover on the day the
 * money arrives — before any invoice exists. The prepayment workflow recorded
 * no tax fact at all, so every advance was booked GROSS against
 * CUSTOMER_PREPAYMENTS and declared nothing. That is right for a security
 * deposit and wrong for an advance on a known 24% domestic service.
 *
 * The missing fact is not "how much" — it is WHAT THE MONEY IS. Three
 * possibilities, and they are recorded, never inferred from description text:
 *
 *  1. `taxable_supply` — an advance on an identified supply, taxable at a
 *     stated VAT code. The receipt itself is the tax point: the gross is split
 *     into net liability + output VAT at the rate IN FORCE on the receipt date,
 *     and that rate is frozen here (`vat_rate_permille`). A later invoice never
 *     reprices it — an advance paid under the 22% era stays 22% even when the
 *     remainder is supplied at 24% (EMTA rate-change guidance).
 *
 *  2. `non_taxable_deposit` — a security deposit or other receipt that is not
 *     consideration for an identified supply. It stays a GROSS liability, which
 *     is what the books did before; the difference is that it now SAYS so.
 *
 *  3. `unresolved` — money arrived and nobody has classified it yet. The
 *     receipt is still recorded (the bank really did move), but the advance is
 *     HELD: not allocatable, not settleable, until an operator classifies it.
 *     This is also what every pre-existing row backfills to — a historical
 *     gross prepayment is not evidence that its supply was non-taxable, and
 *     this migration will not manufacture that claim. No posted voucher is
 *     touched (ADR-0009): reclassifying one to `taxable_supply` reverses the
 *     gross advance and reposts it, it never edits the ledger in place.
 *
 * `vat_base_amount` on an allocation and the `prepayment_refund` table exist so
 * the declared advance VAT is relieved EXACTLY ONCE: a draw-down takes back the
 * share of it that the final invoice now declares, a refund takes back the
 * share that was returned to the customer, and both are measured against what
 * is left rather than against the original amount. The relief is dated at the
 * TAX POINT OF THE SUPPLY it belongs to — the final invoice's own tax point —
 * so the invoice's declaration and the release of the advance's VAT always fall
 * in the SAME period, whenever the draw-down is keyed in. No frozen filing is
 * recomputed: a draw-down whose invoice sits in a locked period is refused
 * outright rather than re-dated into a later one (ADR-0009).
 */
export async function up(db: Kysely<Database>): Promise<void> {
  // ── The advance's own tax facts ───────────────────────────────────────
  await db.schema
    .alterTable('prepayment_advance')
    .addColumn('tax_treatment', 'text', (col) =>
      col
        .notNull()
        .defaultTo('unresolved')
        .check(
          sql`tax_treatment IN ('taxable_supply', 'non_taxable_deposit', 'unresolved')`,
        ),
    )
    .execute();

  // The jurisdiction VAT code the advance was declared under (NULL unless
  // taxable). Resolved by the country plugin at creation — ADR-0002.
  await db.schema
    .alterTable('prepayment_advance')
    .addColumn('vat_code', 'text')
    .execute();

  // The rate IN FORCE on the receipt date, in per mille so it is an exact
  // integer (240 = 24%). Frozen: the advance keeps the rate it was declared at.
  await db.schema
    .alterTable('prepayment_advance')
    .addColumn('vat_rate_permille', 'integer')
    .execute();

  // The gross base-currency minor units received. `original_base_amount`
  // remains the PREPAYMENT LEG (net for a taxable advance, gross otherwise), so
  // every existing balance computation keeps reconciling to the ledger.
  await db.schema
    .alterTable('prepayment_advance')
    .addColumn('gross_base_amount', 'integer')
    .execute();

  // Output VAT declared at the receipt. 0 for a deposit or an unresolved
  // receipt — nothing was declared for those.
  await db.schema
    .alterTable('prepayment_advance')
    .addColumn('vat_base_amount', 'integer', (col) =>
      col.notNull().defaultTo(0),
    )
    .execute();

  // WHICH supply this is an advance on — the identification that makes it
  // taxable turnover rather than an unidentified receipt. Free text, but
  // REQUIRED for a taxable advance: it is the operator's statement of the
  // economic fact, not a classification derived from it.
  await db.schema
    .alterTable('prepayment_advance')
    .addColumn('supply_description', 'text')
    .execute();

  // The advance/pro-forma document number the customer was given for this
  // payment, when one exists. It is the reference a KMD INF row would be
  // issued under; absent means no such document was issued, which is not the
  // same as one whose number we do not know, so it is never invented.
  await db.schema
    .alterTable('prepayment_advance')
    .addColumn('advance_document_number', 'text')
    .execute();

  // The advance tax point: the day the payment was received. Recorded
  // separately from the voucher because an invoice must later state it when it
  // differs from the invoice date (EMTA invoicing handbook).
  await db.schema
    .alterTable('prepayment_advance')
    .addColumn('advance_tax_point_date', 'text')
    .execute();

  // Set when an unresolved advance was reclassified as taxable: its voucher was
  // reversed and a VAT-bearing advance posted in its place. The old row stays —
  // it is what the books said — and points at its replacement.
  await db.schema
    .alterTable('prepayment_advance')
    .addColumn('superseded_by_advance_id', 'integer', (col) =>
      col.references('prepayment_advance.id'),
    )
    .execute();

  // ── The advance VAT one draw-down releases ────────────────────────────
  await db.schema
    .alterTable('prepayment_allocation')
    .addColumn('vat_base_amount', 'integer', (col) =>
      col.notNull().defaultTo(0),
    )
    .execute();

  // ── Refunds of an advance ─────────────────────────────────────────────
  // One row per refund: the posted refund voucher, the bank line that paid it,
  // and the split it took back. `bank_transaction_id` is UNIQUE so a retried
  // call cannot refund the same money twice, and `voucher_id` is UNIQUE so one
  // voucher is one refund.
  await db.schema
    .createTable('prepayment_refund')
    .ifNotExists()
    .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
    .addColumn('advance_id', 'integer', (col) =>
      col.notNull().references('prepayment_advance.id'),
    )
    .addColumn('voucher_id', 'integer', (col) =>
      col.notNull().unique().references('voucher.id'),
    )
    .addColumn('bank_transaction_id', 'integer', (col) =>
      col.notNull().unique().references('bank_transaction.id'),
    )
    // The liability given back and the declared VAT taken back with it.
    .addColumn('net_base_amount', 'integer', (col) => col.notNull())
    .addColumn('vat_base_amount', 'integer', (col) => col.notNull())
    .addColumn('currency', 'text', (col) => col.notNull())
    // The fiscal relief is not taken on a bank line alone: the cancellation /
    // credit document that cancels the advance turnover is named here, with the
    // operator's reason. EMTA's adjustment rules key the correction to that
    // document, so a refund with no document to point at is refused rather
    // than silently reversing declared VAT.
    .addColumn('credit_reference', 'text', (col) => col.notNull())
    .addColumn('reason', 'text', (col) => col.notNull())
    .addColumn('refund_date', 'text', (col) => col.notNull())
    .addColumn('created_at', 'integer', (col) => col.notNull())
    .execute();

  await db.schema
    .createIndex('idx_prepayment_refund_advance')
    .ifNotExists()
    .on('prepayment_refund')
    .columns(['advance_id'])
    .execute();

  // Existing advances: state the backfill rather than relying on SQLite filling
  // an ALTER-added NOT NULL DEFAULT column. Their gross IS their prepayment leg
  // (no VAT was ever split out of it), and they are HELD as 'unresolved' until
  // an operator says what they are.
  await sql`UPDATE prepayment_advance
              SET tax_treatment = 'unresolved'
            WHERE tax_treatment IS NULL`.execute(db);
  await sql`UPDATE prepayment_advance
              SET vat_base_amount = 0
            WHERE vat_base_amount IS NULL`.execute(db);
  await sql`UPDATE prepayment_advance
              SET gross_base_amount = original_base_amount
            WHERE gross_base_amount IS NULL`.execute(db);
  await sql`UPDATE prepayment_allocation
              SET vat_base_amount = 0
            WHERE vat_base_amount IS NULL`.execute(db);
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable('prepayment_refund').ifExists().execute();
  await db.schema
    .alterTable('prepayment_allocation')
    .dropColumn('vat_base_amount')
    .execute();
  for (const column of [
    'superseded_by_advance_id',
    'advance_document_number',
    'advance_tax_point_date',
    'supply_description',
    'vat_base_amount',
    'gross_base_amount',
    'vat_rate_permille',
    'vat_code',
    'tax_treatment',
  ]) {
    await db.schema
      .alterTable('prepayment_advance')
      .dropColumn(column)
      .execute();
  }
}
