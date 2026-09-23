import { useSearchParams } from 'react-router-dom';
import { type SalesInvoice } from '../api';
import {
  entityName,
  invoiceMatchesQuery,
  matchesStatus,
  shortDate,
  STATUS_FILTERS,
  type StatusFilter,
} from '../queries/books';
import { useEntities, useInvoices } from '../queries/shared';
import { AmountText } from '../ui/AmountText';
import { EmptyState, SkeletonRows } from '../ui/Feedback';
import { GroupHeader } from '../ui/GroupHeader';
import { ListGroup, ListRow } from '../ui/List';
import { LoadError } from '../ui/LoadError';
import { ActiveFilters, LABELS, statusChip, StatusChipRow } from './chips';
import {
  BOOKS_RESET_NAME,
  BOOKS_SEARCH,
  useResetWithFocus,
  useSetFilterParam,
} from './filters';
import {
  formatTotals,
  inRange,
  orderSections,
  totalsByCurrency,
  DEFAULT_ORDER,
  type BooksOrderState,
} from './listOrder';

const invoiceTotals = (rows: SalesInvoice[]) =>
  formatTotals(
    totalsByCurrency(
      rows,
      (i) => i.gross_amount,
      (i) => i.currency,
    ),
  );

function InvoiceRow({
  inv,
  customerName,
}: {
  inv: SalesInvoice;
  customerName: string | null;
}) {
  const parts = [inv.invoice_number, shortDate(inv.tax_point_date)];
  if (inv.reconciled) parts.push('🏦');
  if (inv.sent_at != null) parts.push('sent');
  return (
    <ListRow
      to={`/books/invoices/${inv.id}`}
      title={customerName ?? inv.invoice_number}
      subtitle={parts.join(' · ')}
      trailing={
        <div className="flex-none">
          <AmountText
            cents={inv.gross_amount}
            currency={inv.currency}
            showSign
            className="block text-[14px]"
          />
          <div className="mt-0.5">{statusChip(inv.status)}</div>
        </div>
      }
    />
  );
}

/** Books › Invoices — the §4 mirror: customer/number rows, inflow amounts,
 *  month (or per-currency amount-ranked, #279) totals under the active
 *  filter. */
export function InvoicesSegment({
  q,
  order = DEFAULT_ORDER,
}: {
  q: string;
  order?: BooksOrderState;
}) {
  const [params] = useSearchParams();
  const rawStatus = params.get('status');
  const status: StatusFilter = STATUS_FILTERS.includes(
    rawStatus as StatusFilter,
  )
    ? (rawStatus as StatusFilter)
    : 'all';

  const setParam = useSetFilterParam();
  const { rootRef, onReset } = useResetWithFocus('invoices');

  const invoicesQ = useInvoices();
  const entitiesQ = useEntities();
  const entities = entitiesQ.data ?? [];

  // Applied restrictions from PARSED state (an unknown ?status= is All).
  const applied = [
    ...(status === 'all' ? [] : [LABELS[status]]),
    ...order.labels,
  ];
  const activeFilters = (result?: {
    shown: number;
    total: number;
    noun: string;
    totals?: string;
  }) => (
    <ActiveFilters
      filters={applied}
      q={q}
      searchScope={BOOKS_SEARCH.invoices.scope}
      result={result}
      onReset={onReset}
      resetName={BOOKS_RESET_NAME}
    />
  );

  if (invoicesQ.isPending) {
    return (
      <div ref={rootRef} tabIndex={-1} className="outline-none">
        {activeFilters()}
        <SkeletonRows count={5} />
      </div>
    );
  }
  if (invoicesQ.isError) {
    return (
      <div ref={rootRef} tabIndex={-1} className="outline-none">
        {activeFilters()}
        <LoadError
          message={
            invoicesQ.error instanceof Error
              ? invoicesQ.error.message
              : 'Failed to load invoices'
          }
          onRetry={() => void invoicesQ.refetch()}
        />
      </div>
    );
  }

  // Chip counts honour the search AND the date range (data rule 6).
  const searched = (invoicesQ.data ?? []).filter(
    (i) =>
      inRange(i.tax_point_date, order) &&
      invoiceMatchesQuery(i, q, entityName(entities, i.customer_id)),
  );
  const counts = Object.fromEntries(
    STATUS_FILTERS.map((f) => [
      f,
      searched.filter((i) => matchesStatus(i, f)).length,
    ]),
  ) as Record<StatusFilter, number>;
  const filtered = searched.filter((i) => matchesStatus(i, status));
  const sections = orderSections(filtered, order.order, (i) => ({
    id: i.id,
    day: i.tax_point_date,
    amount: i.gross_amount,
    currency: i.currency,
  }));

  const total = (invoicesQ.data ?? []).length;

  return (
    <div ref={rootRef} tabIndex={-1} className="outline-none">
      <StatusChipRow
        counts={counts}
        active={status}
        onChange={(f) => setParam('status', f === 'all' ? null : f)}
      />
      {activeFilters({
        shown: filtered.length,
        total,
        noun: 'invoices',
        totals:
          filtered.length > 0 ? `total ${invoiceTotals(filtered)}` : undefined,
      })}
      {sections.length === 0 && (
        <EmptyState
          icon="📨"
          title="No invoices match"
          hint="Adjust the filter or create one with +"
        />
      )}
      {sections.map((g) => (
        <ListGroup
          key={g.key}
          label={
            <GroupHeader
              wrap
              label={g.label}
              trailing={`${invoiceTotals(g.rows)} · ${g.rows.length}`}
            />
          }
        >
          {g.rows.map((inv) => (
            <InvoiceRow
              key={inv.id}
              inv={inv}
              customerName={entityName(entities, inv.customer_id)}
            />
          ))}
        </ListGroup>
      ))}
    </div>
  );
}
