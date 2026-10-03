import {
  approvalDisplay,
  type InboxEntry,
  type InboxSegment,
} from '../queries/inbox';
import {
  amountMatches,
  textMatches,
  unixDateMatches,
  type SearchNeedle,
} from '../lib/searchText';

type Facts = Parameters<typeof approvalDisplay>[1];

/** What the Inbox search looks at (issue #278) — mirrors the predicate
 *  below, never more: a document in triage has no supplier or amount yet,
 *  and a bank-match approval's figures need a per-item fetch. */
export const INBOX_SEARCH: Record<
  InboxSegment,
  { placeholder: string; scope: string }
> = {
  all: {
    placeholder: 'File name, supplier, invoice no., amount, date…',
    scope:
      'documents by file name or arrival date; expense and sales-invoice approvals by supplier or customer, invoice number or amount; any approval by title or arrival date',
  },
  triage: {
    placeholder: 'File name or arrival date…',
    scope: 'file name or arrival date',
  },
  approvals: {
    placeholder: 'Supplier, invoice no., amount, date…',
    scope:
      'expense and sales-invoice approvals by supplier or customer, invoice number or amount; any approval by title or arrival date',
  },
};

/** Approvals the search can find only by title or arrival date: their
 *  counterparty and amount are not in the lists the Inbox loads. */
export const titleOnlyApproval = (e: InboxEntry): boolean =>
  e.kind === 'approval' &&
  e.approval.object_type !== 'expense' &&
  e.approval.object_type !== 'sales_invoice';

/** One queue entry against the search. Approvals join the loaded
 *  expense/invoice/entity lists exactly as their row does (missing facts
 *  simply cannot match — the screen says so). */
export function inboxEntryMatches(
  entry: InboxEntry,
  needle: SearchNeedle,
  facts: Facts,
): boolean {
  if (unixDateMatches(needle, entry.createdAt)) return true;
  if (entry.kind === 'triage')
    return textMatches(needle, [entry.item.filename]);
  const a = entry.approval;
  const d = approvalDisplay(a, facts);
  const number =
    a.object_type === 'expense'
      ? facts.expenses.find((e) => e.id === a.object_id)
          ?.supplier_invoice_number
      : a.object_type === 'sales_invoice'
        ? facts.invoices.find((i) => i.id === a.object_id)?.invoice_number
        : null;
  return (
    textMatches(needle, [d.title, number]) ||
    amountMatches(needle, d.amountCents)
  );
}
