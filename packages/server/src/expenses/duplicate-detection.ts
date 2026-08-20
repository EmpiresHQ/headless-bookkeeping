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
  const folded = value
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .replace(/I/g, '1')
    .replace(/O/g, '0');
  return folded || null;
}

/**
 * A `reversed` expense is void: the reversal exists precisely so the document
 * can be re-entered, so it must never block creation.
 */
function blocks(row: DuplicateExpenseRow): boolean {
  return row.status !== 'reversed';
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
  // discriminating power and would collapse unrelated expenses.
  if (supplierId == null) return null;

  const candidateNumber = normalizeInvoiceNumber(
    candidate.supplier_invoice_number,
  );
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

  // Rule 2 — fallback, ONLY when the INCOMING document prints no number. A
  // candidate that does print one is identified by it; it must not fall back
  // against peers that merely lack one, or the first row whose number the OCR
  // dropped would refuse every numbered invoice sharing its amount and date.
  if (candidateNumber !== null) return null;

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
