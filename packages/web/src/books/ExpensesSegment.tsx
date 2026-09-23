import { useContext } from 'react';
import { useSearchParams } from 'react-router-dom';
import { type Expense } from '../api';
import {
  documentedExpenseIds,
  entityName,
  expenseMatchesQuery,
  matchesStatus,
  shortDate,
  useDocumentsArchive,
  STATUS_FILTERS,
  type StatusFilter,
} from '../queries/books';
import { useEntities, useExpenses } from '../queries/shared';
import { AmountText } from '../ui/AmountText';
import { Button } from '../ui/Button';
import { SkeletonRows } from '../ui/Feedback';
import { GroupHeader } from '../ui/GroupHeader';
import { ListGroup, ListRow } from '../ui/List';
import { LoadError } from '../ui/LoadError';
import { BooksCreate, BooksEmpty, effectiveDateFilter } from './BooksEmpty';
import {
  ActiveFilters,
  FilterChip,
  LABELS,
  statusChip,
  StatusChipRow,
} from './chips';
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

const expenseTotals = (rows: Expense[]) =>
  formatTotals(
    totalsByCurrency(
      rows,
      (e) => -e.gross_amount,
      (e) => e.currency,
    ),
  );

function ExpenseRow({
  e,
  supplierName,
  hasDocument,
}: {
  e: Expense;
  supplierName: string | null;
  hasDocument: boolean;
}) {
  const parts = [e.category];
  // The supplier's own number identifies the row a search found (#277).
  if ((e.supplier_invoice_number ?? '').trim() !== '')
    parts.push(`Invoice no. ${e.supplier_invoice_number}`);
  parts.push(shortDate(e.tax_point_date));
  if (e.reconciled) parts.push('🏦');
  if (!hasDocument) parts.push('📎 no document');
  return (
    <ListRow
      to={`/books/expenses/${e.id}`}
      title={supplierName ?? e.category}
      subtitle={parts.join(' · ')}
      trailing={
        <div className="flex-none">
          <AmountText
            cents={-e.gross_amount}
            currency={e.currency}
            className="block text-[14px]"
          />
          <div className="mt-0.5">{statusChip(e.status)}</div>
        </div>
      }
    />
  );
}

/** Books › Expenses: supplier-titled rows in month sections with totals
 *  recomputed under the active filter+search (asset §4), or one amount
 *  ranking per currency (#279). Filters live in query params (?status=,
 *  ?nodoc=1, ?from= ?to= ?sort=) — shareable, F5-proof. */
export function ExpensesSegment({
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
  const noDocOnly = params.get('nodoc') === '1';
  const setParam = useSetFilterParam();
  const { rootRef, onReset } = useResetWithFocus('expenses');
  const create = useContext(BooksCreate);

  const expensesQ = useExpenses();
  const entitiesQ = useEntities();
  const docsQ = useDocumentsArchive();
  const entities = entitiesQ.data ?? [];
  // While the archive is still loading (or errored), we cannot know which
  // expenses lack a document — treat everyone as documented rather than
  // flash a false "no document" marker/count for the whole list.
  const docsReady = docsQ.data !== undefined;
  const documented = documentedExpenseIds(docsQ.data ?? []);

  // Applied restrictions, from PARSED state (an unknown ?status= is All).
  // The No-document predicate needs the archive: say so while it cannot
  // apply, and when it applies from a cached archive that failed to refresh.
  const applied: string[] = [];
  if (status !== 'all') applied.push(LABELS[status]);
  if (noDocOnly) {
    applied.push(
      docsReady
        ? docsQ.isError
          ? 'No document (last loaded documents)'
          : 'No document'
        : docsQ.isError
          ? 'No document (not applied: documents failed to load)'
          : 'No document (checking documents…)',
    );
  }
  applied.push(...order.labels);
  const activeFilters = (result?: {
    shown: number;
    total: number;
    noun: string;
    totals?: string;
  }) => (
    <ActiveFilters
      filters={applied}
      q={q}
      searchScope={BOOKS_SEARCH.expenses.scope}
      result={result}
      onReset={onReset}
      resetName={BOOKS_RESET_NAME}
    />
  );

  if (expensesQ.isPending) {
    return (
      <div ref={rootRef} tabIndex={-1} className="outline-none">
        {activeFilters()}
        <SkeletonRows count={5} />
      </div>
    );
  }
  if (expensesQ.isError) {
    return (
      <div ref={rootRef} tabIndex={-1} className="outline-none">
        {activeFilters()}
        <LoadError
          message={
            expensesQ.error instanceof Error
              ? expensesQ.error.message
              : 'Failed to load expenses'
          }
          onRetry={() => void expensesQ.refetch()}
        />
      </div>
    );
  }

  // Chip counts honour the search AND the date range (data rule 6).
  const searched = (expensesQ.data ?? []).filter(
    (e) =>
      inRange(e.tax_point_date, order) &&
      expenseMatchesQuery(e, q, entityName(entities, e.supplier_id)),
  );
  const counts = Object.fromEntries(
    STATUS_FILTERS.map((f) => [
      f,
      searched.filter((e) => matchesStatus(e, f)).length,
    ]),
  ) as Record<StatusFilter, number>;
  const noDocCount = docsReady
    ? searched.filter((e) => !documented.has(e.id)).length
    : 0;
  const filtered = searched
    .filter((e) => matchesStatus(e, status))
    .filter((e) => !noDocOnly || !documented.has(e.id));
  const sections = orderSections(filtered, order.order, (e) => ({
    id: e.id,
    day: e.tax_point_date,
    amount: e.gross_amount,
    currency: e.currency,
  }));

  const total = (expensesQ.data ?? []).length;

  return (
    <div ref={rootRef} tabIndex={-1} className="outline-none">
      <StatusChipRow
        counts={counts}
        active={status}
        onChange={(f) => setParam('status', f === 'all' ? null : f)}
        extra={
          <FilterChip
            active={noDocOnly}
            onClick={() => setParam('nodoc', noDocOnly ? null : '1')}
          >
            📎 No document {noDocCount}
          </FilterChip>
        }
      />
      {activeFilters({
        shown: filtered.length,
        total,
        noun: 'expenses',
        totals:
          filtered.length > 0 ? `total ${expenseTotals(filtered)}` : undefined,
      })}
      {sections.length === 0 && (
        <BooksEmpty
          icon="🧾"
          noun="expenses"
          total={total}
          q={q}
          scope={BOOKS_SEARCH.expenses.scope}
          // Only what removed rows: No document counts once the archive is
          // loaded (before that it filters nothing).
          filters={[
            ...(status === 'all' ? [] : [LABELS[status]]),
            ...(noDocOnly && docsReady ? ['No document'] : []),
            ...effectiveDateFilter(order, order.labels[0]),
          ]}
          lookups={[{ label: 'supplier names', query: entitiesQ }]}
          onReset={onReset}
          restricted={applied.length > 0 || q.trim() !== ''}
          initialHint="Create one, or upload a receipt with +."
          initialAction={
            create && (
              <Button className="min-h-11" onClick={() => create('expense')}>
                Create expense
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
              trailing={`${expenseTotals(g.rows)} · ${g.rows.length}`}
            />
          }
        >
          {g.rows.map((e) => (
            <ExpenseRow
              key={e.id}
              e={e}
              supplierName={entityName(entities, e.supplier_id)}
              hasDocument={!docsReady || documented.has(e.id)}
            />
          ))}
        </ListGroup>
      ))}
    </div>
  );
}
