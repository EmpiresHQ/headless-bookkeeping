import { Link } from 'react-router-dom';
import { relativeTime } from '../relativeTime';
import { useBankStatements, useUnmatchedCounts } from '../queries/bank';
import { Chip } from '../ui/Chip';
import { EmptyState, SkeletonRows } from '../ui/Feedback';
import { LinkButton } from '../ui/LinkButton';
import { ListGroup, ListRow } from '../ui/List';
import { LargeTitleHeader } from '../shell/Headers';
import { formatStatementPeriod } from './format';
import { LoadError } from './LoadError';

/** /bank — statements list. The row answers "which period, is there work
 *  left": period title + unmatched badge (IDs are not data). */
export function StatementsScreen() {
  const statementsQ = useBankStatements();
  const statements = statementsQ.data ?? [];
  // Newest period first.
  const sorted = [...statements].sort((a, b) =>
    b.start_date.localeCompare(a.start_date),
  );
  const counts = useUnmatchedCounts(sorted.map((s) => s.id));

  return (
    <div className="mx-auto max-w-3xl pb-6">
      <LargeTitleHeader
        title="Bank"
        trailing={
          <Link
            to="/bank/import"
            viewTransition
            className="text-[15px] font-semibold text-accent"
          >
            Import
          </Link>
        }
      />
      {statementsQ.isPending && <SkeletonRows count={3} />}
      {statementsQ.isError && (
        <LoadError
          message={
            statementsQ.error instanceof Error
              ? statementsQ.error.message
              : 'Failed to load statements'
          }
          onRetry={() => void statementsQ.refetch()}
        />
      )}
      {statementsQ.isSuccess && sorted.length === 0 && (
        <EmptyState
          icon="🏦"
          title="No statements yet"
          hint="Import a bank statement to start reconciling."
          action={<LinkButton to="/bank/import">Import statement</LinkButton>}
        />
      )}
      {sorted.length > 0 && (
        <ListGroup>
          {sorted.map((s) => {
            const count = counts.get(s.id);
            return (
              <ListRow
                key={s.id}
                to={`/bank/statements/${s.id}`}
                title={formatStatementPeriod(s.start_date, s.end_date)}
                subtitle={`Uploaded ${relativeTime(s.uploaded_at)}`}
                trailing={
                  count === undefined ? null : count > 0 ? (
                    <Chip tone="warn">{count} unmatched</Chip>
                  ) : (
                    <Chip tone="ok">done ✓</Chip>
                  )
                }
              />
            );
          })}
        </ListGroup>
      )}
    </div>
  );
}
