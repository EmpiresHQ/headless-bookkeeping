import type { QueryClient } from '@tanstack/react-query';
import {
  getNeedsTriageItems,
  triageDocument,
  type DocumentRow,
  type Entity,
  type TriageOutcome,
} from '../api';
import { inboxKeys, invalidateInbox } from '../queries/inbox';

/**
 * The ONE document-upload flow behind every entry point (issue #258): the
 * Books "+" menu and the Inbox header open the same sheet, send the same
 * input and continue by the same rules. This module holds the pure parts
 * and the post-upload stages; the sheet owns the upload itself and the
 * partial-success record (#251).
 *
 * Server facts this relies on (documents.service.ts upload,
 * intake-workflow.service.ts processInner, triage.service.ts):
 * - A known file (same hash) is NOT stored again: the response is the
 *   existing row, untouched — a newly chosen claimant is ignored.
 * - Triage replays an already-routed document only when it has its own
 *   draft; a processed document without one (a bank statement, a receipt
 *   filed against another expense) is re-run from OCR. So a known
 *   duplicate that is no longer `pending` is never sent to triage again.
 * - `kind: 'expense'` also covers a receipt matched to an EXISTING expense
 *   (nothing created), so its receipt never says "created".
 */

/** A file the server accepted, bound to the exact File it was sent as
 *  (#251): a retry of the same File resumes from here and never uploads
 *  again. The payer is fixed with it — `claimantId` is what was SENT,
 *  `document.claimant_id` what the server STORED (they differ only on a
 *  duplicate, where the server keeps the existing row). A successful
 *  triage is recorded in `outcome` the moment it returns, so a failure
 *  in any later read resumes from it and never processes again. */
export interface StagedUpload {
  file: File;
  claimantId: string;
  document: DocumentRow;
  deduplicated: boolean;
  outcome: TriageOutcome | null;
}

/** Does this staged upload still need a processing (triage) call? Only a
 *  new document, or a known duplicate still `pending`, and only until a
 *  triage has returned. */
export function needsProcessing(staged: StagedUpload): boolean {
  return (
    staged.outcome === null &&
    (!staged.deduplicated || staged.document.status === 'pending')
  );
}

/** Where a run stopped: nothing stored / stored but not processed / nothing
 *  left to process, but the result could not be loaded. */
export function failedStage(
  staged: StagedUpload | null,
): 'upload' | 'processing' | 'result' {
  if (staged === null) return 'upload';
  return needsProcessing(staged) ? 'processing' : 'result';
}

export type UploadResult =
  /** A new draft from this document, or its receipt filed against an
   *  existing expense (the server reports both as `expense`). */
  | { kind: 'expense'; documentId: number; expenseId: number }
  | { kind: 'invoice'; documentId: number; invoiceId: number }
  | { kind: 'bank_statement'; documentId: number; jobId: number }
  | { kind: 'needs_triage'; documentId: number; reason: string }
  /** Not routed to an outcome and not in the triage queue — `ran`: this
   *  run processed it (vs. a known duplicate found this way). */
  | {
      kind: 'not_queued';
      documentId: number;
      reason: string | null;
      ran: boolean;
    }
  /** A known duplicate that was already handled — nothing re-run. */
  | { kind: 'on_file'; documentId: number; status: string };

/** Employees and directors are the out-of-pocket payers (ADR-0036) —
 *  never a supplier. */
export function claimantOptions(entities: Entity[]): Entity[] {
  return entities.filter((e) => e.role === 'employee' || e.role === 'director');
}

/** A deduplicated upload whose STORED payer is not what the operator chose
 *  (or is not reported at all): the server ignored the new choice, so the
 *  flow must stop and say so before anything continues. */
export function payerMismatch(staged: StagedUpload): boolean {
  if (!staged.deduplicated) return false;
  const stored = staged.document.claimant_id;
  if (stored === undefined) return true;
  return (stored === null ? '' : String(stored)) !== staged.claimantId;
}

/** The stored payer in words, for the mismatch notice. */
export function storedPayerLabel(
  document: DocumentRow,
  entities: Entity[],
): string {
  const stored = document.claimant_id;
  if (stored === undefined) return 'an unconfirmed payer';
  if (stored === null) return 'company paid';
  const name = entities.find((e) => e.id === stored)?.name;
  return `paid by ${name ?? `entity #${stored}`}`;
}

async function inTriageQueue(
  qc: QueryClient,
  documentId: number,
): Promise<{ reason: string } | null> {
  const items = await qc.fetchQuery({
    queryKey: inboxKeys.needsTriage,
    queryFn: getNeedsTriageItems,
    staleTime: 0,
  });
  return items.find((i) => i.id === documentId) ?? null;
}

async function resolveOutcome(
  qc: QueryClient,
  o: TriageOutcome,
  check: () => void,
): Promise<UploadResult> {
  const documentId = o.document_id;
  switch (o.kind) {
    case 'expense':
      // Either a new draft from this document or its receipt filed against
      // an EXISTING expense — the outcome does not say which, so the receipt
      // claims neither (no extra read just to tell them apart).
      return { kind: 'expense', documentId, expenseId: o.expense_id };
    case 'invoice':
      return { kind: 'invoice', documentId, invoiceId: o.invoice_id };
    case 'bank_statement':
      return { kind: 'bank_statement', documentId, jobId: o.job_id };
    default: {
      // 'unknown' says the workflow did not route it — whether it now waits
      // in the triage queue is read, not assumed.
      const item = await inTriageQueue(qc, documentId);
      check();
      return item !== null
        ? { kind: 'needs_triage', documentId, reason: item.reason }
        : { kind: 'not_queued', documentId, reason: o.reason, ran: true };
    }
  }
}

/** Everything after the upload: continue by the document's authoritative
 *  status, resolve the outcome, refresh the caches. `check` is the pending
 *  operation's stage guard. */
export async function continueUpload(
  qc: QueryClient,
  staged: StagedUpload,
  check: () => void,
  /** Told the moment a processing call returned (#259), before any
   *  further await — so its outcome is recorded even if a read fails. */
  onProcessed?: (outcome: TriageOutcome) => void,
): Promise<UploadResult> {
  // Ownership before the first stage, whatever the caller checked.
  check();
  const { document } = staged;
  let result: UploadResult;
  if (needsProcessing(staged)) {
    const outcome = await triageDocument(document.id);
    // Recorded BEFORE any further await: from here on a retry only
    // re-reads, it never processes the document again.
    staged.outcome = outcome;
    check();
    onProcessed?.(outcome);
  }
  if (staged.outcome !== null) {
    result = await resolveOutcome(qc, staged.outcome, check);
  } else if (document.status === 'needs_triage') {
    // A known duplicate waiting for review: confirmed by the queue read; a
    // failed read fails the run (retry re-reads) — never a processing call.
    const item = await inTriageQueue(qc, document.id);
    check();
    result =
      item !== null
        ? { kind: 'needs_triage', documentId: document.id, reason: item.reason }
        : {
            kind: 'not_queued',
            documentId: document.id,
            reason: null,
            ran: false,
          };
  } else {
    result = {
      kind: 'on_file',
      documentId: document.id,
      status: document.status,
    };
  }
  await invalidateInbox(qc);
  check();
  return result;
}

/** Where the operator continues, and what the receipt says. No raw
 *  document ids except to name a duplicate the operator must recognize. */
export function continuation(
  r: UploadResult,
  deduplicated: boolean,
): { to: string; message: string; tone: 'ok' | 'warn' } {
  const dup = deduplicated
    ? `Already uploaded as document #${r.documentId} — `
    : '';
  switch (r.kind) {
    case 'expense':
      return {
        to: `/books/expenses/${r.expenseId}`,
        message: `${dup}Processed — here is the expense this document belongs to`,
        tone: 'ok',
      };
    case 'invoice':
      return {
        to: `/books/invoices/${r.invoiceId}`,
        message: `${dup}Sales invoice recorded`,
        tone: 'ok',
      };
    case 'bank_statement':
      return {
        to: `/bank/import?job=${r.jobId}`,
        message: `${dup}Bank statement — import started`,
        tone: 'ok',
      };
    case 'needs_triage':
      return {
        to: `/inbox/doc/${r.documentId}`,
        message: `${dup}Needs your review: ${r.reason}`,
        tone: 'warn',
      };
    case 'not_queued':
      return {
        to: `/books/documents/${r.documentId}`,
        message: r.ran
          ? `${dup}Processed without a result and not in the review queue${r.reason ? ` (${r.reason})` : ''} — check the document`
          : `${dup}it is not in the review queue now — check the document`,
        tone: 'warn',
      };
    case 'on_file':
      return {
        to: `/books/documents/${r.documentId}`,
        message: `Already uploaded as document #${r.documentId} — nothing was processed again`,
        tone: 'ok',
      };
  }
}

type Link = { label: string; to: string };

const docLinkOf = (documentId: number): Link => ({
  label: `Document #${documentId}`,
  to: `/books/documents/${documentId}`,
});

/** Where a processing outcome lives (#259) — known before its result is
 *  read, so a failed read still leaves the created object reachable. */
export function outcomeLinks(o: TriageOutcome): Link[] {
  const doc = docLinkOf(o.document_id);
  switch (o.kind) {
    case 'expense':
      return [
        {
          label: `Expense #${o.expense_id}`,
          to: `/books/expenses/${o.expense_id}`,
        },
        doc,
      ];
    case 'invoice':
      return [
        {
          label: `Invoice #${o.invoice_id}`,
          to: `/books/invoices/${o.invoice_id}`,
        },
        doc,
      ];
    case 'bank_statement':
      return [
        {
          label: `Import job #${o.job_id}`,
          to: `/bank/import?job=${o.job_id}`,
        },
        doc,
      ];
    default:
      return [doc];
  }
}

/** The recorded result's links: the continuation first, then the document. */
export function resultLinks(r: UploadResult): Link[] {
  const doc = docLinkOf(r.documentId);
  switch (r.kind) {
    case 'expense':
      return [
        {
          label: `Expense #${r.expenseId}`,
          to: `/books/expenses/${r.expenseId}`,
        },
        doc,
      ];
    case 'invoice':
      return [
        {
          label: `Invoice #${r.invoiceId}`,
          to: `/books/invoices/${r.invoiceId}`,
        },
        doc,
      ];
    case 'bank_statement':
      return [
        { label: `Import job #${r.jobId}`, to: `/bank/import?job=${r.jobId}` },
        doc,
      ];
    case 'needs_triage':
      return [
        {
          label: `Review document #${r.documentId}`,
          to: `/inbox/doc/${r.documentId}`,
        },
        doc,
      ];
    default:
      return [doc];
  }
}
