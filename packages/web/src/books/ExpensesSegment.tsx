import { useSearchParams } from 'react-router-dom';
import { fmtCents, type Expense } from '../api';
import {
  documentedExpenseIds,
  entityName,
  expenseMatchesQuery,
  groupByMonth,
  matchesStatus,
  shortDate,
  useDocumentsArchive,
  STATUS_FILTERS,
  type StatusFilter,
} from '../queries/books';
import { useEntities, useExpenses } from '../queries/shared';
import { AmountText } from '../ui/AmountText';
import { EmptyState, SkeletonRows } from '../ui/Feedback';
import { ListGroup, ListRow } from '../ui/List';
import { LoadError } from '../ui/LoadError';
import { statusChip, StatusChipRow } from './chips';

/** Month-section header content: label left, filtered total right. */
function GroupHeader({
  label,
  totalCents,
  count,
}: {
  label: string;
  totalCents: number;
  count: number;
}) {
  return (
    <span className="flex w-full items-baseline justify-between">
      <span>{label}</span>
      <span className="whitespace-nowrap tabular-nums">
        −{fmtCents(totalCents)} € · {count}
      </span>
    </span>
  );
}

function ExpenseRow({
  e,
  supplierName,
  hasDocument,
}: {
  e: Expense;
  supplierName: string | null;
  hasDocument: boolean;
}) {
  const parts = [e.category, shortDate(e.tax_point_date)];
  if (e.reconciled) parts.push('🏦');
  if (!hasDocument) parts.push('📎 no document');
  return (
    <ListRow
      to={`/books/expenses/${e.id}`}
      title={supplierName ?? e.category}
      subtitle={parts.join(' · ')}
      trailing={
        <div className="flex-none">
          <AmountText cents={-e.gross_amount} className="block text-[14px]" />
          <div className="mt-0.5">{statusChip(e.status)}</div>
        </div>
      }
    />
  );
}

/** Books › Expenses: supplier-titled rows in month sections with totals
 *  recomputed under the active filter+search (asset §4). Filters live in
 *  query params (?status=, ?nodoc=1) — shareable, F5-proof. */
export function ExpensesSegment({ q }: { q: string }) {
  const [params, setParams] = useSearchParams();
  const rawStatus = params.get('status');
  const status: StatusFilter = STATUS_FILTERS.includes(
    rawStatus as StatusFilter,
  )
    ? (rawStatus as StatusFilter)
    : 'all';
  const noDocOnly = params.get('nodoc') === '1';

  const expensesQ = useExpenses();
  const entitiesQ = useEntities();
  const docsQ = useDocumentsArchive();
  const entities = entitiesQ.data ?? [];
  const documented = documentedExpenseIds(docsQ.data ?? []);

  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(params);
    if (value === null) next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  };

  if (expensesQ.isPending) return <SkeletonRows count={5} />;
  if (expensesQ.isError) {
    return (
      <LoadError
        message={
          expensesQ.error instanceof Error
            ? expensesQ.error.message
            : 'Failed to load expenses'
        }
        onRetry={() => void expensesQ.refetch()}
      />
    );
  }

  const searched = (expensesQ.data ?? []).filter((e) =>
    expenseMatchesQuery(e, q, entityName(entities, e.supplier_id)),
  );
  const counts = Object.fromEntries(
    STATUS_FILTERS.map((f) => [
      f,
      searched.filter((e) => matchesStatus(e, f)).length,
    ]),
  ) as Record<StatusFilter, number>;
  const noDocCount = searched.filter((e) => !documented.has(e.id)).length;
  const filtered = searched
    .filter((e) => matchesStatus(e, status))
    .filter((e) => !noDocOnly || !documented.has(e.id));
  const groups = groupByMonth(filtered);

  return (
    <div>
      <StatusChipRow
        counts={counts}
        active={status}
        onChange={(f) => setParam('status', f === 'all' ? null : f)}
        extra={
          <button
            type="button"
            onClick={() => setParam('nodoc', noDocOnly ? null : '1')}
            className={`flex-none whitespace-nowrap rounded-full px-3 py-1 text-[12px] font-semibold ${
              noDocOnly ? 'bg-accent text-white' : 'bg-surface text-ink-2'
            }`}
          >
            📎 No document {noDocCount}
          </button>
        }
      />
      {groups.length === 0 && (
        <EmptyState
          icon="🧾"
          title="No expenses match"
          hint="Adjust the filter or create one with +"
        />
      )}
      {groups.map((g) => (
        <ListGroup
          key={g.month}
          label={
            <GroupHeader
              label={g.label}
              totalCents={g.totalCents}
              count={g.count}
            />
          }
        >
          {g.rows.map((e) => (
            <ExpenseRow
              key={e.id}
              e={e}
              supplierName={entityName(entities, e.supplier_id)}
              hasDocument={documented.has(e.id)}
            />
          ))}
        </ListGroup>
      ))}
    </div>
  );
}
