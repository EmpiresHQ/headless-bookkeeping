import { Kysely, sql } from 'kysely';
import { Database } from '../types';

/**
 * The facts that decide whether input VAT is RECLAIMABLE at all (issue #211).
 *
 * Until now the books recorded one VAT fact about ourselves — `vat_registered`
 * — and nothing read it on the purchase side. Every purchase therefore booked
 * a deductible VAT_RECEIVABLE, so a non-registered organisation declared input
 * VAT it has no right to (KMD row 5 is deductible only under KMS §§29–31), and
 * a reverse-charge acquisition self-assessed output VAT and immediately
 * deducted it back to zero.
 *
 * Deduction entitlement is not derivable from `vat_registered`, because being
 * liable for VAT and being entitled to deduct it are different questions:
 *
 *  1. `vat_registration_kind` — an ORDINARY taxable person (maksukohustuslane)
 *     deducts; a LIMITED one (piiratud maksukohustuslane, registered because it
 *     receives specified foreign services) self-assesses the output tax and
 *     deducts NOTHING (EMTA handbook, limited liability VAT payer). One flag
 *     cannot carry both, so the kind is recorded separately. Defaulting to
 *     'ordinary' is the statutory norm and preserves how every existing
 *     registered organisation was already treated.
 *
 *  2. `input_vat_entitlement` — full / partial / none. Partial is the real case
 *     the KMD instructions name for row 5: inputs used for both business and
 *     non-business, or for both taxable and exempt supply, are deductible only
 *     in part. It is stored as an explicit fact rather than inferred, and
 *     backfilled to 'none' for an organisation that is not registered — which
 *     is what its books meant all along, now said out loud.
 *
 *  3. `input_vat_deduction_permille` — the partial proportion, in PER MILLE so
 *     it is an exact integer (0…1000) and the deductible amount is an integer
 *     fraction of the tax, never a float percentage. Required exactly when the
 *     entitlement is 'partial'; forbidden otherwise, so a stale proportion
 *     cannot sit behind a 'full' or 'none' setting and be read by mistake.
 *
 * This is NOT an annual pro-rata settlement engine (KMS §32 lg 4 recalculation
 * at year end): it records the proportion a posting is made at, which is what
 * the ledger needs to book the right legs and what an adjustment would later be
 * measured against.
 *
 * On `voucher`, the proportion a purchase was actually POSTED at is frozen next
 * to it. An organisation's settings change; a posted voucher must keep saying
 * what it was booked on, and a filed return must stay reconcilable to it. The
 * columns are NULL on every pre-existing voucher and on every voucher with no
 * input-VAT decision to record (a sale, a system entry) — "not recorded",
 * which is honest, rather than a retro-fitted 'full'.
 */
export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .alterTable('organization')
    .addColumn('vat_registration_kind', 'text', (col) =>
      col
        .notNull()
        .defaultTo('ordinary')
        .check(sql`vat_registration_kind IN ('ordinary', 'limited')`),
    )
    .execute();

  await db.schema
    .alterTable('organization')
    .addColumn('input_vat_entitlement', 'text', (col) =>
      col
        .notNull()
        .defaultTo('full')
        .check(sql`input_vat_entitlement IN ('full', 'partial', 'none')`),
    )
    .execute();

  await db.schema
    .alterTable('organization')
    .addColumn('input_vat_deduction_permille', 'integer', (col) =>
      col.check(
        sql`(input_vat_entitlement = 'partial'
              AND input_vat_deduction_permille IS NOT NULL
              AND input_vat_deduction_permille BETWEEN 0 AND 1000)
            OR (input_vat_entitlement <> 'partial'
              AND input_vat_deduction_permille IS NULL)`,
      ),
    )
    .execute();

  // An organisation that is not VAT-registered has no deduction right at all,
  // whatever the column default says. Say so in the data rather than leaving
  // 'full' standing and relying on every reader to remember the gate.
  await db
    .updateTable('organization')
    .set({ input_vat_entitlement: 'none' })
    .where('vat_registered', '=', 0)
    .execute();

  await db.schema
    .alterTable('voucher')
    .addColumn('input_vat_entitlement_basis', 'text')
    .execute();
  await db.schema
    .alterTable('voucher')
    .addColumn('input_vat_deduction_numerator', 'integer')
    .execute();
  await db.schema
    .alterTable('voucher')
    .addColumn('input_vat_deduction_denominator', 'integer')
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema
    .alterTable('voucher')
    .dropColumn('input_vat_deduction_denominator')
    .execute();
  await db.schema
    .alterTable('voucher')
    .dropColumn('input_vat_deduction_numerator')
    .execute();
  await db.schema
    .alterTable('voucher')
    .dropColumn('input_vat_entitlement_basis')
    .execute();
  await db.schema
    .alterTable('organization')
    .dropColumn('input_vat_deduction_permille')
    .execute();
  await db.schema
    .alterTable('organization')
    .dropColumn('input_vat_entitlement')
    .execute();
  await db.schema
    .alterTable('organization')
    .dropColumn('vat_registration_kind')
    .execute();
}
