import { useQuery, type QueryClient } from '@tanstack/react-query';
import {
  fmtCents,
  getCreditNote,
  getDocumentDetails,
  getDocuments,
  getExpense,
  listApprovals,
  listCreditNotes,
  type Approval,
  type CreditNote,
  type Entity,
  type Expense,
  type SalesInvoice,
} from '../api';
import { sharedKeys } from './keys';

/**
 * Books data layer. Lists themselves come from the SHARED hooks
 * (useExpenses/useInvoices — frozen sharedKeys, Plan 03); this module adds
 * the Books-only reads and the PURE list model (month groups, filters,
 * search, joins) so grouping/totals are unit-testable without React.
 * NO refetchInterval anywhere here (Global Constraints).
 */
export const booksKeys = {
  all: ['books'] as const,
  documents: ['books', 'documents'] as const,
  docDetails: (id: number) => ['books', 'doc', id, 'details'] as const,
  creditNotes: ['books', 'credit-notes'] as const,
  creditNote: (id: number) => ['books', 'credit-notes', id] as const,
  expense: (id: number) => ['books', 'expense', id] as const,
  rejection: (objectType: 'expense' | 'sales_invoice', objectId: number) =>
    ['books', 'rejection', objectType, objectId] as const,
};

export const useDocumentsArchive = () =>
  useQuery({ queryKey: booksKeys.documents, queryFn: getDocuments });

/** Persisted intake artifacts only — never a reclassify (ADR-0039). */
export const useDocDetails = (id: number) =>
  useQuery({
    queryKey: booksKeys.docDetails(id),
    queryFn: () => getDocumentDetails(id),
  });

export const useCreditNotes = () =>
  useQuery({ queryKey: booksKeys.creditNotes, queryFn: listCreditNotes });

export const useCreditNoteDetail = (id: number) =>
  useQuery({
    queryKey: booksKeys.creditNote(id),
    queryFn: () => getCreditNote(id),
  });

/** Single-expense facts for the expense detail (document_id, ai fields,
 *  claimant, created_at — the list subset has none of these). */
export const useExpenseFacts = (id: number) =>
  useQuery({ queryKey: booksKeys.expense(id), queryFn: () => getExpense(id) });

/** Newest rejected approval for the object, or null. Enabled only for
 *  drafts — that is the state a rejection returns an object to. */
export function newestRejection(
  approvals: Approval[],
  objectId: number,
): Approval | null {
  const mine = approvals
    .filter((a) => a.object_id === objectId)
    .sort((a, b) => (b.resolved_at ?? 0) - (a.resolved_at ?? 0));
  return mine[0] ?? null;
}

export function useRejectedReason(
  objectType: 'expense' | 'sales_invoice',
  objectId: number,
  enabled: boolean,
) {
  return useQuery({
    queryKey: booksKeys.rejection(objectType, objectId),
    queryFn: () =>
      listApprovals({ status: 'rejected', object_type: objectType }),
    select: (rows) => newestRejection(rows, objectId),
    enabled,
  });
}

/** After any Books mutation: Books reads, the shared lists the rows join
 *  against, AND the Inbox (posting a draft can mint an approval; deletes/
 *  corrections change what Inbox rows join against). */
export function invalidateBooks(qc: QueryClient): Promise<void> {
  return Promise.all([
    qc.invalidateQueries({ queryKey: booksKeys.all }),
    qc.invalidateQueries({ queryKey: sharedKeys.expenses }),
    qc.invalidateQueries({ queryKey: sharedKeys.invoices }),
    qc.invalidateQueries({ queryKey: ['inbox'] }),
  ]).then(() => undefined);
}

// ── Pure list model ────────────────────────────────────────────────────────

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;
const MONTHS_SHORT = MONTHS.map((m) => m.slice(0, 3));

/** '2026-07-03' → '2026-07'. Pure string math — timezone-proof (Plan 03
 *  lexicographic-ISO discipline). */
export const monthKey = (isoDate: string): string => isoDate.slice(0, 7);

export function monthLabel(month: string): string {
  const [y, m] = month.split('-');
  return `${MONTHS[Number(m) - 1]} ${y}`;
}

/** '2026-07-03' → '3 Jul' — the short list form of a CALENDAR fact
 *  (tax point), distinct from relativeTime (activity timestamps). */
export function shortDate(isoDate: string): string {
  const [, m, d] = isoDate.split('-');
  return `${Number(d)} ${MONTHS_SHORT[Number(m) - 1]}`;
}

export interface MonthGroup<T> {
  month: string; // '2026-07'
  label: string; // 'July 2026'
  rows: T[];
  totalCents: number; // sum of gross under the ACTIVE filter
  count: number;
}

/** Month sections, newest month first, newest tax-point first inside each.
 *  Call it with the ALREADY-FILTERED rows so totals honor the filter
 *  (spec data rule 6). */
export function groupByMonth<
  T extends { tax_point_date: string; gross_amount: number },
>(rows: T[]): MonthGroup<T>[] {
  const byMonth = new Map<string, T[]>();
  for (const r of rows) {
    const k = monthKey(r.tax_point_date);
    const bucket = byMonth.get(k);
    if (bucket) bucket.push(r);
    else byMonth.set(k, [r]);
  }
  return [...byMonth.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([month, rs]) => ({
      month,
      label: monthLabel(month),
      rows: [...rs].sort((a, b) =>
        b.tax_point_date.localeCompare(a.tax_point_date),
      ),
      totalCents: rs.reduce((s, r) => s + r.gross_amount, 0),
      count: rs.length,
    }));
}

/** Status filter chips. `corrected` is the human name for the server's
 *  `reversed` (Reality #1: the corrected figures ARE live). */
export type StatusFilter = 'all' | 'draft' | 'pending' | 'posted' | 'corrected';
export const STATUS_FILTERS: readonly StatusFilter[] = [
  'all',
  'draft',
  'pending',
  'posted',
  'corrected',
];

export function matchesStatus(
  row: { status: string },
  f: StatusFilter,
): boolean {
  if (f === 'all') return true;
  if (f === 'corrected') return row.status === 'reversed';
  return row.status === f;
}

const norm = (s: string) => s.toLowerCase();

export function expenseMatchesQuery(
  row: Expense,
  q: string,
  supplierName: string | null,
): boolean {
  const needle = norm(q.trim());
  if (needle === '') return true;
  return [supplierName ?? '', row.category, fmtCents(row.gross_amount)].some(
    (hay) => norm(hay).includes(needle),
  );
}

export function invoiceMatchesQuery(
  row: SalesInvoice,
  q: string,
  customerName: string | null,
): boolean {
  const needle = norm(q.trim());
  if (needle === '') return true;
  return [
    customerName ?? '',
    row.invoice_number,
    fmtCents(row.gross_amount),
  ].some((hay) => norm(hay).includes(needle));
}

export const entityName = (
  entities: Entity[],
  id: number | null,
): string | null =>
  id == null ? null : (entities.find((e) => e.id === id)?.name ?? null);

/** Expense ids that HAVE a linked source document (archive join) — the
 *  complement wears the 📎 "No document" marker (Reality #12). */
export function documentedExpenseIds(
  docs: { expense_id: number | null }[],
): Set<number> {
  const set = new Set<number>();
  for (const d of docs) if (d.expense_id != null) set.add(d.expense_id);
  return set;
}

/** Client mirror of the server's over-credit cap (credit-notes.service.ts:
 *  93-103) — POSTED notes against the object reduce what remains. The
 *  server stays the authority; this only makes the form honest up front. */
export function remainingCreditable(
  objectGrossCents: number,
  notes: Pick<
    CreditNote,
    'credits_object_type' | 'credits_object_id' | 'status' | 'gross_amount'
  >[],
  objectType: 'sales_invoice' | 'expense',
  objectId: number,
): number {
  const credited = notes
    .filter(
      (n) =>
        n.credits_object_type === objectType &&
        n.credits_object_id === objectId &&
        n.status === 'posted',
    )
    .reduce((s, n) => s + n.gross_amount, 0);
  return objectGrossCents - credited;
}
