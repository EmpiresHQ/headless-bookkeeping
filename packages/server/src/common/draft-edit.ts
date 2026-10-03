import { z } from 'zod';

/**
 * Shared building blocks for the draft-edit PATCH schemas (issue #247).
 *
 * A draft edit is a strict, deterministic contract: every amount is an integer
 * in minor units, every date a real calendar date, every currency an ISO-4217
 * shaped code — and a field the caller may NOT edit is refused by name, with
 * the reason, rather than silently dropped from the payload.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** `YYYY-MM-DD` AND a date that exists (no 2026-02-30). */
export function isRealIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export const isoDateSchema = z
  .string()
  .refine(isRealIsoDate, 'must be a real calendar date (YYYY-MM-DD)');

export const currencyCodeSchema = z
  .string()
  .regex(/^[A-Z]{3}$/, 'must be a 3-letter uppercase ISO 4217 code');

/** Gross: a positive integer number of minor units (cents). */
export const grossMinorSchema = z
  .number()
  .int('must be an integer number of minor units (cents)')
  .positive('must be greater than zero');

/** VAT: a non-negative integer number of minor units (cents). */
export const vatMinorSchema = z
  .number()
  .int('must be an integer number of minor units (cents)')
  .nonnegative('cannot be negative');

/** An optional free-text reference: trimmed, and blank means "none". */
export const optionalTextSchema = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? null : v),
  z.string().trim().max(200).nullable(),
);

/**
 * A CLOSED draft-edit object: `z.strictObject`, so the published contract
 * (OpenAPI `additionalProperties: false`, generated CLI types) matches what
 * the runtime accepts. A key outside the shape is refused — never silently
 * dropped — and the refusal names each key with its reason: keys listed in
 * `immutable` explain why they cannot change, anything else is "not editable".
 */
export function draftEditObject<Shape extends z.ZodRawShape>(
  shape: Shape,
  immutable: Readonly<Record<string, string>>,
) {
  const editable = Object.keys(shape);
  return z.strictObject(shape, {
    error: (issue) => {
      if (issue.code !== 'unrecognized_keys') return undefined;
      return issue.keys
        .map(
          (key) =>
            immutable[key] ??
            `'${key}' is not an editable draft field (editable: ${editable.join(', ')})`,
        )
        .join('; ');
    },
  });
}
