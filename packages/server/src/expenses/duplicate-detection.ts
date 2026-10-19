/**
 * Deterministic duplicate-expense detection (issue #195, ADR-0010).
 *
 * ADR-0010 assumed triage would catch duplicates before a voucher exists. It
 * does not: the byte-identical hash only catches identical files, and the
 * `(supplier, invoice_number)` collision it describes was never implemented.
 * Four duplicate pairs reached the books in production. This module is the
 * deterministic key that replaces the missing guard.
 *
 * The key, evaluated in order:
 *   1. Both sides print a number -> match on (supplier_id, normalised number).
 *   2. The INCOMING document prints no number -> fall back to
 *      (supplier_id, currency, gross_amount, tax_point_date, claimant_id).
 *
 * The fallback is deliberately gated on the incoming side having no number.
 * Running it whenever step 1 misses would collapse the five legitimate Anomaly
 * invoices of 16.00 dated 2026-05-31 into one and silently drop four
 * deductions. Gating it on "a number is missing on EITHER side" has the same
 * effect one OCR failure later: production pair 96/97 shows the number going
 * unextracted, and a single numberless row would then bridge every numbered
 * peer that shares its amount and date, refusing all of them. A document that
 * DOES print a number is identified by that number and by nothing weaker.
 *
 * The fallback also compares currency, because equal minor-unit amounts in
 * different currencies are different money, and claimant, because two
 * employees buying the same item from one supplier on one day made two
 * purchases and are owed two reimbursements.
 *
 * Pure by design — no DB, no DI, no Nest. The caller supplies the rows, so the
 * same key can back the guard, an admin report or a migration audit.
 */

/** The subset of an `expense` row the key reads. */
export interface DuplicateExpenseRow {
  id: number;
  supplier_id: number | null;
  supplier_invoice_number: string | null;
  currency: string;
  gross_amount: number;
  tax_point_date: string;
  status: string;
  /** Set when the expense was paid by an employee (migration 056). */
  claimant_id: number | null;
  /** The LLM's document type for the document this expense came from. */
  ai_document_type: string | null;
}

/** The subset of a would-be expense the key reads. */
export interface DuplicateCandidate {
  supplier_id?: number | null;
  supplier_invoice_number?: string | null;
  currency: string;
  gross_amount: number;
  tax_point_date: string;
  claimant_id?: number | null;
}

/** Which of the two rules fired. */
export type DuplicateMatchKind = 'invoice_number' | 'amount_and_date';

export interface DuplicateDetection {
  /** The expense the candidate appears to duplicate (the earliest surviving one). */
  existingExpenseId: number;
  matchedOn: DuplicateMatchKind;
  /**
   * `ai_document_type` of the matched expense. The caller needs it to tell the
   * invoice+receipt email pair (the receipt evidences a purchase already
   * booked) from two independent number-less receipts of one supplier on one
   * day (two real purchases, so a human must look).
   */
  existingDocumentType: string | null;
  /**
   * Human-readable, and load-bearing: it must keep the lowercase marker
   * "possible duplicate of" so `classifyReasonType` buckets a resulting
   * needs_triage finding as `possible_duplicate`.
   */
  reason: string;
}

/**
 * Canonicalize a printed invoice number for comparison: uppercase, strip
 * everything non-alphanumeric (spaces, hyphens, slashes, the `#` prefix), then
 * fold the OCR confusables I -> 1 and O -> 0. Production pair 72/73 differs
 * only by those two damages: `RI7USPNX0014` vs `R17USPNX-0014`.
 *
 * Returns null when nothing usable is left, so an empty or punctuation-only
 * number is treated exactly like an absent one (and routes to the fallback).
 */
export function normalizeInvoiceNumber(
  value: string | null | undefined,
): string | null {
  if (value == null) return null;
  // A date-shaped value is not an invoice number (issue #405): when a
  // columnar layout extraction anchors on a label and takes the following
  // token, it reads the NEXT field's value (a date) as this field's number.
  // Such a pseudo number identifies nothing — two sibling invoices extracted
  // the same date-shaped key and false-positive duplicate-gated each other —
  // so it is treated exactly like an absent number (which routes to the
  // amount+date fallback instead of pretending to identify the document).
  // Only separator-delimited full dates match: a real number that merely
  // contains digits (`5001799762`, `RI7USPNX0014`) is never date-shaped.
  if (isDateShapedInvoiceNumber(value)) return null;
  const folded = value
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .replace(/I/g, '1')
    .replace(/O/g, '0');
  return folded || null;
}

/**
 * `D.M.Y` / `Y-M-D` style printed dates (any of `.`, `-`, `/` as separator)
 * with PLAUSIBLE day (01–31) and month (01–12) components and a full 2- or
 * 4-digit year: what a label-anchored extraction reads when it takes the
 * FOLLOWING token's value as an invoice number (issue #405: `02.10.2026`).
 * The full-year/plausible-component structure keeps ordinary structured
 * serial numbers (`1-2-3`, `1234-56-7890`) as real keys — two separators
 * alone are not enough to call a printed number a date.
 */
const DATE_SHAPED_DMY =
  /^(?:0?[1-9]|[12]\d|3[01])[.\-/](?:0?[1-9]|1[0-2])[.\-/](?:\d{4}|\d{2})$/;
const DATE_SHAPED_YMD =
  /^(?:\d{4}|\d{2})[.\-/](?:0?[1-9]|1[0-2])[.\-/](?:0?[1-9]|[12]\d|3[01])$/;

function isDateShapedInvoiceNumber(value: string): boolean {
  const trimmed = value.trim();
  return DATE_SHAPED_DMY.test(trimmed) || DATE_SHAPED_YMD.test(trimmed);
}

/**
 * A gross amount usable as a duplicate key (issue #405): finite and
 * positive. A failed extraction persists zero/NaN junk drafts whose key
 * would otherwise block the very valid invoices it was extracted from; and
 * an invalid candidate cannot be recognised as a duplicate of anything.
 */
function isUsableAmount(gross: number): boolean {
  return Number.isFinite(gross) && gross > 0;
}

/**
 * A `reversed` expense is void: the reversal exists precisely so the document
 * can be re-entered, so it must never block creation.
 *
 * An expense whose amount never survived extraction (issue #405's zero-gross
 * junk drafts) is equally void as a KEY: it identifies no purchase, so it can
 * neither block a valid invoice nor anchor the amount+date fallback.
 */
function blocks(row: DuplicateExpenseRow): boolean {
  return row.status !== 'reversed' && isUsableAmount(row.gross_amount);
}

/**
 * Find the expense `candidate` appears to duplicate, or null.
 *
 * `existing` is any set of expense rows; the caller decides the scope (all
 * expenses of the supplier, in practice). Rows are considered in ascending id
 * order so the reason names the ORIGINAL, not the most recent copy.
 */
export function findDuplicateExpense(
  candidate: DuplicateCandidate,
  existing: readonly DuplicateExpenseRow[],
): DuplicateDetection | null {
  const supplierId = candidate.supplier_id;
  // A NULL supplier groups nothing: without a counterparty the key has no
  // discriminating power and would collapse unrelated expenses. The same
  // holds for a candidate whose own extraction failed (issue #405): a
  // zero/NaN gross is not a purchase, so it can be nobody's duplicate.
  if (supplierId == null) return null;
  if (!isUsableAmount(candidate.gross_amount)) return null;

  const candidateNumber = normalizeInvoiceNumber(
    candidate.supplier_invoice_number,
  );
  // A date-shaped pseudo number is a FAILED extraction, not an absent one
  // (issue #405 root review). The incoming document DID print something in the
  // number field, so it must not fall back to the weaker amount/date key
  // that ADR-0010 reserves for genuinely numberless documents — that would
  // false-positive the very next healthy invoice of the same amount and day.
  // It is simply not identifiable: no number match, and no fallback either.
  const printedJunkNumber =
    candidate.supplier_invoice_number != null &&
    isDateShapedInvoiceNumber(candidate.supplier_invoice_number);
  const peers = [...existing]
    .filter((row) => row.supplier_id === supplierId && blocks(row))
    .sort((a, b) => a.id - b.id);

  // Rule 1 — same supplier, same normalised number, both sides printed one.
  if (candidateNumber !== null) {
    const hit = peers.find(
      (row) =>
        normalizeInvoiceNumber(row.supplier_invoice_number) === candidateNumber,
    );
    if (hit) {
      return {
        existingExpenseId: hit.id,
        matchedOn: 'invoice_number',
        existingDocumentType: hit.ai_document_type,
        reason:
          `possible duplicate of expense #${hit.id}: same supplier and ` +
          `invoice number ${candidate.supplier_invoice_number ?? ''}.`,
      };
    }
  }

  // Rule 2 — fallback, ONLY when the INCOMING document prints no number at
  // all. A candidate that does print one — a real number, OR a date-shaped
  // pseudo number from a failed extraction — is identified by nothing weaker
  // than that printed number: falling back would collapse the first healthy
  // invoice sharing the junk draft's amount and date into a false duplicate.
  if (candidateNumber !== null || printedJunkNumber) return null;

  const candidateClaimant = candidate.claimant_id ?? null;
  const fallback = peers.find(
    (row) =>
      row.currency === candidate.currency &&
      row.gross_amount === candidate.gross_amount &&
      row.tax_point_date === candidate.tax_point_date &&
      (row.claimant_id ?? null) === candidateClaimant,
  );
  if (fallback) {
    return {
      existingExpenseId: fallback.id,
      matchedOn: 'amount_and_date',
      existingDocumentType: fallback.ai_document_type,
      reason:
        `possible duplicate of expense #${fallback.id}: same supplier, gross ` +
        `amount ${(candidate.gross_amount / 100).toFixed(2)} ` +
        `${candidate.currency} and tax point date ` +
        `${candidate.tax_point_date}, and the incoming document carries no ` +
        `invoice number.`,
    };
  }

  return null;
}
