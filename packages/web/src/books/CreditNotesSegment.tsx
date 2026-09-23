import {
  type CreditNote,
  type Entity,
  type Expense,
  type SalesInvoice,
} from '../api';
import { entityName, shortDate, useCreditNotes } from '../queries/books';
import { useEntities, useExpenses, useInvoices } from '../queries/shared';
import { AmountText } from '../ui/AmountText';
import { EmptyState, SkeletonRows } from '../ui/Feedback';
import { LinkButton } from '../ui/LinkButton';
import { ListGroup, ListRow } from '../ui/List';
import { LoadError } from '../ui/LoadError';
import { ActiveFilters, statusChip } from './chips';
import { BOOKS_RESET_NAME, BOOKS_SEARCH, useResetWithFocus } from './filters';
import {
  formatTotals,
  inRange,
  orderSections,
  totalsByCurrency,
  DEFAULT_ORDER,
  type BooksOrderState,
} from './listOrder';

export interface CreditedContext {
  expenses: Expense[];
  invoices: SalesInvoice[];
  entities: Entity[];
}

/** Business-terms display for a credit note (data rule 1: the row answers
 *  "what does this credit", never "row #7"). */
export function creditNoteDisplay(
  n: CreditNote,
  ctx: CreditedContext,
): { title: string; subtitle: string; objectRoute: string | null } {
  if (n.credits_object_type === 'sales_invoice') {
    const inv = ctx.invoices.find((i) => i.id === n.credits_object_id);
    const customer = inv ? entityName(ctx.entities, inv.customer_id) : null;
    return {
      title: inv
        ? customer
          ? `${customer} · Invoice ${inv.invoice_number}`
          : `Invoice ${inv.invoice_number}`
        : n.credit_note_number,
      subtitle: `${n.credit_note_number} · credits invoice · ${shortDate(n.tax_point_date)}`,
      objectRoute: inv ? `/books/invoices/${inv.id}` : null,
    };
  }
  const e = ctx.expenses.find((x) => x.id === n.credits_object_id);
  const supplier = e ? entityName(ctx.entities, e.supplier_id) : null;
  return {
    title: e
      ? supplier
        ? `${supplier} · Expense ${e.category}`
        : `Expense ${e.category}`
      : n.credit_note_number,
    subtitle: `${n.credit_note_number} · credits expense · ${shortDate(n.tax_point_date)}`,
    objectRoute: e ? `/books/expenses/${e.id}` : null,
  };
}

/** Sign: a sales credit note reduces income (−); a purchase credit note
 *  reduces cost (+). */
export const creditNoteSign = (n: CreditNote): number =>
  n.credits_object_type === 'sales_invoice' ? -n.gross_amount : n.gross_amount;

export function CreditNotesSegment({
  q,
  order = DEFAULT_ORDER,
}: {
  q: string;
  order?: BooksOrderState;
}) {
  // No status filters here: the search, the date range and the order
  // (#279) are the restrictions. With only a search applied, the button
  // says what it does — Clear search; otherwise it is the Books Reset.
  const { rootRef, onReset } = useResetWithFocus('credit-notes');
  const notesQ = useCreditNotes();
  const expensesQ = useExpenses();
  const invoicesQ = useInvoices();
  const entitiesQ = useEntities();
  const ctx: CreditedContext = {
    expenses: expensesQ.data ?? [],
    invoices: invoicesQ.data ?? [],
    entities: entitiesQ.data ?? [],
  };

  const activeFilters = (result?: {
    shown: number;
    total: number;
    noun: string;
    totals?: string;
  }) => (
    <ActiveFilters
      filters={order.labels}
      q={q}
      searchScope={BOOKS_SEARCH['credit-notes'].scope}
      result={result}
      onReset={onReset}
      {...(order.labels.length === 0
        ? { resetLabel: 'Clear search', resetName: 'Clear search' }
        : { resetName: BOOKS_RESET_NAME })}
    />
  );

  if (notesQ.isPending) {
    return (
      <div ref={rootRef} tabIndex={-1} className="outline-none">
        {activeFilters()}
        <SkeletonRows count={4} />
      </div>
    );
  }
  if (notesQ.isError) {
    return (
      <div ref={rootRef} tabIndex={-1} className="outline-none">
        {activeFilters()}
        <LoadError
          message={
            notesQ.error instanceof Error
              ? notesQ.error.message
              : 'Failed to load credit notes'
          }
          onRetry={() => void notesQ.refetch()}
        />
      </div>
    );
  }

  const needle = q.trim().toLowerCase();
  const rows = (notesQ.data ?? []).filter((n) => {
    if (!inRange(n.tax_point_date, order)) return false;
    if (needle === '') return true;
    const d = creditNoteDisplay(n, ctx);
    return (
      d.title.toLowerCase().includes(needle) ||
      n.credit_note_number.toLowerCase().includes(needle)
    );
  });
  // Amount order ranks the note's face value (gross_amount), whichever side
  // it credits, one ranking per currency; totals are the signed net.
  const sections = orderSections(rows, order.order, (n) => ({
    id: n.id,
    day: n.tax_point_date,
    amount: n.gross_amount,
    currency: n.currency,
  }));

  const total = (notesQ.data ?? []).length;

  return (
    <div ref={rootRef} tabIndex={-1} className="outline-none">
      {activeFilters({
        shown: rows.length,
        total,
        noun: 'credit notes',
        totals:
          rows.length > 0
            ? `net ${formatTotals(
                totalsByCurrency(rows, creditNoteSign, (n) => n.currency),
              )}`
            : undefined,
      })}
      <div className="px-4 pb-3">
        <LinkButton
          to="/books/credit-notes/new"
          variant="secondary"
          className="w-full"
        >
          New credit note
        </LinkButton>
      </div>
      {sections.length === 0 && (
        <EmptyState
          icon="🧾"
          title="No credit notes"
          hint="Issue one from a posted invoice or expense detail"
        />
      )}
      {sections.map((g) => (
        <ListGroup key={g.key} label={g.label}>
          {g.rows.map((n) => {
            const d = creditNoteDisplay(n, ctx);
            return (
              <ListRow
                key={n.id}
                to={`/books/credit-notes/${n.id}`}
                title={d.title}
                subtitle={d.subtitle}
                trailing={
                  <div className="flex-none">
                    <AmountText
                      cents={creditNoteSign(n)}
                      currency={n.currency}
                      showSign
                      className="block text-[14px]"
                    />
                    <div className="mt-0.5">{statusChip(n.status)}</div>
                  </div>
                }
              />
            );
          })}
        </ListGroup>
      ))}
    </div>
  );
}
