import { Button } from '../ui/Button';
import { LoadError } from '../ui/LoadError';

/**
 * Honest status of a pre-close CHECK (issue #255): a failed or still-loading
 * query must never read as "checked — nothing found". Deliberately tiny — the
 * constituents are plain React Query results.
 *
 * - `checking`    no data yet, a retry in flight, or — with `afterMount` —
 *                 no result has landed since this observer mounted
 * - `unavailable` a constituent failed and has nothing cached
 * - `stale`       a refresh failed; only an earlier result is cached
 * - `checked`     every constituent holds (fresh enough) data
 *
 * `afterMount` freshness is React Query's per-OBSERVER generation proof
 * (`isFetchedAfterMount`: data/error update count past the one captured when
 * the observer was created), never a wall-clock comparison — a cache write
 * and a sheet open can share a millisecond (and do under a frozen clock).
 * Without it, a plain background refetch over good data stays `checked`.
 */
export type CheckState = 'checking' | 'checked' | 'unavailable' | 'stale';

export interface CheckQuery {
  data: unknown;
  error: unknown;
  isError: boolean;
  isFetching: boolean;
  errorUpdateCount: number;
  isFetchedAfterMount: boolean;
  refetch: () => unknown;
}

function oneState(q: CheckQuery, afterMount: boolean): CheckState {
  // isError is checked below, so a post-mount ERROR never passes as fresh.
  const outdated =
    q.data === undefined || (afterMount && !q.isFetchedAfterMount);
  if (q.isFetching && (q.isError || outdated)) return 'checking';
  if (q.isError) return q.data === undefined ? 'unavailable' : 'stale';
  return outdated ? 'checking' : 'checked';
}

export function checkState(
  queries: CheckQuery[],
  afterMount = false,
): CheckState {
  const states = queries.map((q) => oneState(q, afterMount));
  if (states.includes('unavailable')) return 'unavailable';
  if (queries.some((q) => q.data === undefined)) return 'checking';
  if (states.includes('stale')) return 'stale';
  if (states.includes('checking')) return 'checking';
  return 'checked';
}

/** Refetch only the constituents that are not `checked` — never the lot. */
export function retryFailed(queries: CheckQuery[], afterMount = false): void {
  for (const q of queries) {
    if (oneState(q, afterMount) !== 'checked') void q.refetch();
  }
}

export function checkError(queries: CheckQuery[]): string | null {
  const failed = queries.find((q) => q.isError);
  if (failed === undefined) return null;
  return failed.error instanceof Error
    ? failed.error.message
    : 'Request failed';
}

/** Change-detection key for an acknowledgement: any new failure, retry
 *  outcome or different set of incomplete checks yields a new signature. */
export function checkSignature(
  checks: { key: string; state: CheckState; queries: CheckQuery[] }[],
): string {
  return checks
    .filter((c) => c.state !== 'checked')
    .map(
      (c) =>
        `${c.key}:${c.state}:${c.queries.map((q) => q.errorUpdateCount).join('/')}`,
    )
    .join('|');
}

/** Section-level status line for anything short of `checked`. */
export function CheckNotice({
  what,
  queries,
  afterMount = false,
}: {
  /** Lower-case noun phrase, e.g. "undecided items". */
  what: string;
  queries: CheckQuery[];
  afterMount?: boolean;
}) {
  const state = checkState(queries, afterMount);
  const message = checkError(queries);
  if (state === 'checked') return null;
  if (state === 'checking') {
    return (
      <p role="status" className="mx-6 mb-3.5 text-[12.5px] text-ink-2">
        Checking {what}…
      </p>
    );
  }
  if (state === 'unavailable') {
    return (
      <LoadError
        message={`Couldn't check ${what}${message !== null ? ` — ${message}` : ''}`}
        onRetry={() => retryFailed(queries, afterMount)}
      />
    );
  }
  return (
    <div className="mx-3.5 mb-3.5 rounded-2xl bg-warn-bg px-4 py-3">
      <p className="text-[13px] text-warn">
        Couldn't refresh {what}
        {message !== null ? ` — ${message}` : ''}. Showing the last loaded
        result.
      </p>
      <Button
        variant="secondary"
        className="mt-2"
        onClick={() => retryFailed(queries, afterMount)}
      >
        Retry
      </Button>
    </div>
  );
}
