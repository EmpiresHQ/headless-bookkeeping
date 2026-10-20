import { z } from 'zod';

/**
 * The LLM's output: how to read ONE bank's CSV. A column reference is a header
 * name; transforms are a small fixed vocabulary the deterministic transformer
 * understands. Kept deliberately narrow so a malformed mapping fails Zod rather
 * than smuggling arbitrary behavior into the kernel.
 */

/**
 * An OPTIONAL settlement-FX evidence target (issue #403): where in the CSV a
 * line's original-currency evidence lives. `column` names the header; the
 * optional `pattern` extracts the value from that column's cell when the
 * evidence is embedded in a free-text cell (a description like "60 DKK;
 * conversion fee 0.08 EUR; bank rate 0.1338333 EUR/DKK") rather than a column
 * of its own. Without a pattern the whole cell is the value.
 *
 * The pattern is a plain regular expression applied by the DETERMINISTIC
 * transformer — the LLM emits rules, never parsed rows (ADR-0031) — and it is
 * the agent's ONLY way to carry evidence a bank keeps in descriptions; a
 * per-bank parser is exactly what ADR-0031 rejects. A malformed pattern fails
 * the run with a surfaced error, the same way an unmappable column does.
 */
const fxEvidenceTargetSchema = z.object({
  column: z.string().min(1),
  pattern: z.string().min(1).nullable().optional(),
});

export const mappingRulesetSchema = z.object({
  account_code: z.string(),
  date_column: z.string(),
  date_format: z.string(),
  amount: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('signed'), column: z.string() }),
    z.object({
      mode: z.literal('debit_credit'),
      amount_column: z.string(),
      indicator_column: z.string(),
      debit_value: z.string(),
    }),
  ]),
  currency_column: z.string().nullable(),
  default_currency: z.string(),
  description_column: z.string().nullable(),
  counterparty_iban_column: z.string().nullable(),
  counterparty_descriptor_column: z.string().nullable(),
  reference_column: z.string().nullable(),
  // Settlement-FX evidence targets (issue #403). All optional: a statement in
  // the account's own currency has none, and absent targets leave the
  // corresponding transaction fields NULL (absent evidence, not zero).
  /** The line's original currency (e.g. "DKK" for a converted card charge). */
  source_currency: fxEvidenceTargetSchema.nullable().optional(),
  /** The original amount in the source currency (decimal, e.g. "60.00"). */
  source_amount: fxEvidenceTargetSchema.nullable().optional(),
  /** The bank's explicit conversion rate (base per source unit). */
  fx_rate: fxEvidenceTargetSchema.nullable().optional(),
  /** The bank's separately charged conversion fee (decimal, base currency). */
  conversion_fee: fxEvidenceTargetSchema.nullable().optional(),
  /** The bank's own booking date, when the statement distinguishes it. */
  booking_date: fxEvidenceTargetSchema.nullable().optional(),
  /**
   * The reference-rate OBSERVATION the bank itself prints on the line, when
   * the statement carries it as a distinct field. Retained UNVERIFIED — the
   * bank's own report, never a statutory provenance (issue #403).
   */
  bank_reference_rate: fxEvidenceTargetSchema.nullable().optional(),
});

export type MappingRuleset = z.infer<typeof mappingRulesetSchema>;
