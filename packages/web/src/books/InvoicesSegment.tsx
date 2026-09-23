import { useSearchParams } from 'react-router-dom';
import { type SalesInvoice } from '../api';
import { signedEuros } from '../lib/money';
import {
  entityName,
  groupByMonth,
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
import { BOOKS_SEARCH, useResetWithFocus, useSetFilterParam } from './filters';

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
 *  month totals under the active filter. */
export function InvoicesSegment({ q }: { q: string }) {
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
  const applied = status === 'all' ? [] : [LABELS[status]];
  const activeFilters = (result?: {
    shown: number;
    total: number;
    noun: string;
  }) => (
    <ActiveFilters
      filters={applied}
      q={q}
      searchScope={BOOKS_SEARCH.invoices.scope}
      result={result}
      onReset={onReset}
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

  const searched = (invoicesQ.data ?? []).filter((i) =>
    invoiceMatchesQuery(i, q, entityName(entities, i.customer_id)),
  );
  const counts = Object.fromEntries(
    STATUS_FILTERS.map((f) => [
      f,
      searched.filter((i) => matchesStatus(i, f)).length,
    ]),
  ) as Record<StatusFilter, number>;
  const filtered = searched.filter((i) => matchesStatus(i, status));
  const groups = groupByMonth(filtered);

  const total = (invoicesQ.data ?? []).length;

  return (
    <div ref={rootRef} tabIndex={-1} className="outline-none">
      <StatusChipRow
        counts={counts}
        active={status}
        onChange={(f) => setParam('status', f === 'all' ? null : f)}
      />
      {activeFilters({ shown: filtered.length, total, noun: 'invoices' })}
      {groups.length === 0 && (
        <EmptyState
          icon="📨"
          title="No invoices match"
          hint="Adjust the filter or create one with +"
        />
      )}
      {groups.map((g) => (
        <ListGroup
          key={g.month}
          label={
            <GroupHeader
              label={g.label}
              trailing={`${signedEuros(g.totalCents)} · ${g.count}`}
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
