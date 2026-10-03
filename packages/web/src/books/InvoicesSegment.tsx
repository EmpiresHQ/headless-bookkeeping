import { useContext } from 'react';
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
import { Button } from '../ui/Button';
import { SkeletonRows } from '../ui/Feedback';
import { GroupHeader } from '../ui/GroupHeader';
import { ListGroup } from '../ui/List';
import { LoadError } from '../ui/LoadError';
import { BooksCreate, BooksEmpty, effectiveDateFilter } from './BooksEmpty';
import { useReturnPosition } from '../lib/listPosition';
import { BooksColumnsHeader, BooksRow, type BooksColumns } from './BooksRow';
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

/** Desktop columns (xl, issue #283). */
export const INVOICE_COLUMNS: BooksColumns = {
  grid: 'xl:grid-cols-[minmax(0,1.8fr)_minmax(0,1.2fr)_5.5rem_minmax(0,0.8fr)_minmax(9rem,1.1fr)_5.5rem_0.75rem]',
  labels: ['Customer', 'Invoice no.', 'Tax point', 'Notes', 'Amount', 'Status'],
  amountAt: 4,
};

function InvoiceRow({
  inv,
  customerName,
}: {
  inv: SalesInvoice;
  customerName: string | null;
}) {
  const notes: string[] = [];
  if (inv.reconciled) notes.push('🏦');
  if (inv.sent_at != null) notes.push('sent');
  return (
    <BooksRow
      to={`/books/invoices/${inv.id}`}
      columns={INVOICE_COLUMNS}
      title={customerName ?? inv.invoice_number}
      titleXl={
        customerName != null
          ? undefined
          : inv.customer_id == null
            ? 'No customer'
            : // Assigned, but its name is not loaded — never "No customer".
              `Customer #${inv.customer_id}`
      }
      cells={[
        // A customer-less card is titled by its number; the column keeps it.
        {
          key: 'number',
          value: inv.invoice_number,
          xlOnly: customerName == null,
        },
        { key: 'date', value: shortDate(inv.tax_point_date) },
        { key: 'notes', value: notes.join(' · ') },
      ]}
      amount={
        <AmountText
          cents={inv.gross_amount}
          currency={inv.currency}
          showSign
          className="block text-[14px]"
        />
      }
      status={statusChip(inv.status)}
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
  const create = useContext(BooksCreate);

  const invoicesQ = useInvoices();
  // Back from a row lands on that row again, once the rows are here (#283).
  useReturnPosition(rootRef, invoicesQ.isSuccess);
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
        <BooksEmpty
          icon="📨"
          noun="invoices"
          total={total}
          q={q}
          scope={BOOKS_SEARCH.invoices.scope}
          filters={[
            ...(status === 'all' ? [] : [LABELS[status]]),
            ...effectiveDateFilter(order, order.labels[0]),
          ]}
          lookups={[{ label: 'customer names', query: entitiesQ }]}
          onReset={onReset}
          restricted={applied.length > 0 || q.trim() !== ''}
          initialHint="Create your first sales invoice."
          initialAction={
            create && (
              <Button className="min-h-11" onClick={() => create('invoice')}>
                Create invoice
              </Button>
            )
          }
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
          <BooksColumnsHeader columns={INVOICE_COLUMNS} />
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
