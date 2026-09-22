import { useQuery } from '@tanstack/react-query';
import { fmtCents, getDocumentDetails, getExpense } from '../api';
import { booksKeys } from '../queries/books';
import { inboxKeys } from '../queries/inbox';
import { Button } from '../ui/Button';
import { SkeletonRows } from '../ui/Feedback';
import { LinkButton } from '../ui/LinkButton';
import { LoadError } from '../ui/LoadError';
import { Sheet } from '../ui/Sheet';

// Persisted triage findings currently carry the reference in server-generated
// text. Accept only that format; never guess an expense from unrelated numbers.
export function duplicateExpenseId(reason: string | null): number | null {
  const match =
    /^(?:receipt for expense #[1-9]\d*: )?possible duplicate of expense #([1-9]\d*):/.exec(
      reason ?? '',
    );
  const id = match ? Number(match[1]) : NaN;
  return Number.isSafeInteger(id) ? id : null;
}

export function DuplicateReviewSheet({
  documentId,
  reason,
  open,
  onOpenChange,
  onArchive,
}: {
  documentId: number;
  reason: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onArchive: () => void;
}) {
  const expenseId = duplicateExpenseId(reason);
  const existingQ = useQuery({
    queryKey: booksKeys.expense(expenseId ?? 0),
    queryFn: () => getExpense(expenseId!),
    enabled: open && expenseId !== null,
    retry: false,
  });
  const detailsQ = useQuery({
    queryKey: inboxKeys.docDetails(documentId),
    queryFn: () => getDocumentDetails(documentId),
    enabled: open,
  });
  const classification = detailsQ.data?.classification;
  const current = classification?.ok ? classification.result : null;
  const existing = existingQ.data;
  const money = (
    amount: number | null | undefined,
    currency: string | null | undefined,
  ) =>
    amount == null ? 'Not extracted' : `${fmtCents(amount)} ${currency ?? '—'}`;
  const rows = existing
    ? [
        [
          'Invoice number',
          current?.supplier_invoice_number,
          existing.supplier_invoice_number,
        ],
        ['Date', current?.tax_point_date, existing.tax_point_date],
        [
          'Total',
          money(current?.gross_amount, current?.currency),
          money(existing.gross_amount, existing.currency),
        ],
        [
          'VAT',
          money(current?.vat_amount, current?.currency),
          money(existing.vat_amount, existing.currency),
        ],
        ['Category', current?.category, existing.category],
      ]
    : [];

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title="Review possible duplicate"
    >
      <div className="space-y-4 px-5 pb-4">
        <p className="text-sm text-ink-2">
          Compare this document with the existing expense before deciding
          whether to archive it.
        </p>
        {expenseId === null ? (
          <p role="status">
            The existing expense reference is unavailable. Check Books before
            archiving this document.
          </p>
        ) : existingQ.isPending ? (
          <SkeletonRows count={3} />
        ) : existingQ.isError ? (
          <LoadError
            message="Could not load the existing expense. It may no longer be available."
            onRetry={() => void existingQ.refetch()}
          />
        ) : existing ? (
          <>
            <p className="font-semibold">
              Expense #{existing.id} · {existing.status}
            </p>
            {detailsQ.isPending ? (
              <SkeletonRows count={2} />
            ) : detailsQ.isError ? (
              <LoadError
                message="Could not load this document’s extracted data."
                onRetry={() => void detailsQ.refetch()}
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr>
                      <th className="p-2">Field</th>
                      <th className="p-2">This document</th>
                      <th className="p-2">Existing expense</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(([label, value, previous]) => (
                      <tr key={label} className="border-t border-line">
                        <th scope="row" className="p-2">
                          {label}
                        </th>
                        <td className="break-words p-2">
                          {value ?? 'Not extracted'}
                        </td>
                        <td className="break-words p-2">
                          {previous ?? 'Not recorded'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="flex flex-col gap-2">
              <LinkButton to={`/books/expenses/${existing.id}`}>
                Open existing expense
              </LinkButton>
              {existing.document_id !== null && (
                <LinkButton to={`/books/documents/${existing.document_id}`}>
                  Open existing document
                </LinkButton>
              )}
              <Button onClick={onArchive}>Archive this duplicate</Button>
            </div>
            <p className="text-sm text-ink-2">
              Archive only if both documents belong to the same purchase.
              Archiving does not change the existing expense.
            </p>
          </>
        ) : null}
        <Button variant="secondary" onClick={() => onOpenChange(false)}>
          Close review
        </Button>
      </div>
    </Sheet>
  );
}
