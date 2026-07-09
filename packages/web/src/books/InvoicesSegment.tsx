import { useSearchParams } from 'react-router-dom';
import { fmtCents, type SalesInvoice } from '../api';
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
import { ListGroup, ListRow } from '../ui/List';
import { LoadError } from '../ui/LoadError';
import { statusChip, StatusChipRow } from './chips';

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
  const [params, setParams] = useSearchParams();
  const rawStatus = params.get('status');
  const status: StatusFilter = STATUS_FILTERS.includes(
    rawStatus as StatusFilter,
  )
    ? (rawStatus as StatusFilter)
    : 'all';

  const invoicesQ = useInvoices();
  const entitiesQ = useEntities();
  const entities = entitiesQ.data ?? [];

  if (invoicesQ.isPending) return <SkeletonRows count={5} />;
  if (invoicesQ.isError) {
    return (
      <LoadError
        message={
          invoicesQ.error instanceof Error
            ? invoicesQ.error.message
            : 'Failed to load invoices'
        }
        onRetry={() => void invoicesQ.refetch()}
      />
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

  return (
    <div>
      <StatusChipRow
        counts={counts}
        active={status}
        onChange={(f) => {
          const next = new URLSearchParams(params);
          if (f === 'all') next.delete('status');
          else next.set('status', f);
          setParams(next, { replace: true });
        }}
      />
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
            <span className="flex w-full items-baseline justify-between">
              <span>{g.label}</span>
              <span className="whitespace-nowrap tabular-nums">
                +{fmtCents(g.totalCents)} € · {g.count}
              </span>
            </span>
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
