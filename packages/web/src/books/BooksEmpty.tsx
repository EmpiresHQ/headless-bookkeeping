import { createContext, type ReactNode } from 'react';
import { Button } from '../ui/Button';
import { EmptyState } from '../ui/Feedback';

export type BooksCreateKind = 'expense' | 'invoice' | 'upload';

/** Opens one of BooksScreen's own create sheets — the same path as the +
 *  menu, so the sheets' guards, lookups and completion flows are reused
 *  (issue #280). Null outside BooksScreen: no create action is offered. */
export const BooksCreate = createContext<
  ((kind: BooksCreateKind) => void) | null
>(null);

/** An auxiliary read the segment's SEARCH depends on (a supplier name comes
 *  from the entities list, not from the row). */
export interface SearchLookup {
  /** Plural, lower case: 'supplier names'. */
  label: string;
  query: { data: unknown; isError: boolean; refetch: () => unknown };
}

type LookupState = 'ready' | 'loading' | 'failed' | 'stale';

const lookupState = ({ query: q }: SearchLookup): LookupState =>
  q.data === undefined
    ? q.isError
      ? 'failed'
      : 'loading'
    : q.isError
      ? 'stale'
      : 'ready';

const listJoin = (xs: readonly string[]): string =>
  xs.length <= 1
    ? (xs[0] ?? '')
    : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;

const SEARCH_EXCERPT = 32;

/**
 * The zero-rows state of a Books segment (issue #280), told apart from
 * EFFECTIVE state — never raw URL flags:
 * - nothing loaded at all → "No … yet" with the segment's create action;
 * - rows exist but the search, the filters, or both remove them all → says
 *   which, with "Show all …" running the segment's own Reset;
 * - a search that could not look at every name (lookup still loading or
 *   failed) does not claim "no match"; a failed read offers Retry even
 *   while another is still loading.
 * The query shows as a bounded excerpt (full value in the search field).
 * Loading and a failed primary load stay the segment's skeleton/LoadError.
 */
export function BooksEmpty({
  icon,
  noun,
  total,
  q,
  scope,
  filters,
  lookups = [],
  onReset,
  initialHint,
  initialAction,
  restricted,
}: {
  icon: string;
  noun: string;
  /** Rows in the successfully loaded primary list. */
  total: number;
  q: string;
  /** What the search matches here (BOOKS_SEARCH[seg].scope). */
  scope: string;
  /** Restrictions that actually applied to the rows (not sort, not a
   *  not-applied date or an unknown status). */
  filters: readonly string[];
  /** Reads the search depends on; only consulted for a search. */
  lookups?: readonly SearchLookup[];
  onReset: () => void;
  initialHint: string;
  initialAction?: ReactNode;
  /** Anything is in the ActiveFilters line (Reset is offered there). */
  restricted: boolean;
}) {
  const needle = q.trim();
  if (total === 0) {
    return wrap(
      <EmptyState
        icon={icon}
        title={`No ${noun} yet`}
        hint={
          restricted
            ? `${initialHint} The search and filters are not hiding any.`
            : initialHint
        }
        action={initialAction}
      />,
    );
  }

  const searching = needle !== '';
  const excerpt =
    needle.length > SEARCH_EXCERPT
      ? `${needle.slice(0, SEARCH_EXCERPT)}…`
      : needle;
  const withState = searching
    ? lookups.map((l) => ({ label: l.label, state: lookupState(l), l }))
    : [];
  const pick = (s: LookupState) =>
    withState.filter((x) => x.state === s).map((x) => x.label);
  const loading = pick('loading');
  const failed = pick('failed');
  const stale = pick('stale');
  const retryable = withState.filter(
    (x) => x.state === 'failed' || x.state === 'stale',
  );

  // Some searched facts are missing: never claim the whole scope was
  // searched, nor "no match".
  const incomplete = loading.length > 0 || failed.length > 0;
  const titleParts: string[] = [];
  if (loading.length > 0) titleParts.push(`Still loading ${listJoin(loading)}`);
  if (failed.length > 0) titleParts.push(`couldn't search ${listJoin(failed)}`);
  let title: string;
  if (incomplete) title = cap(titleParts.join('; '));
  else if (searching && filters.length > 0)
    title = `No ${noun} match this search and these filters`;
  else if (searching) title = `No ${noun} match “${excerpt}”`;
  else title = `No ${noun} match these filters`;

  const hint: string[] = [];
  const within = filters.length > 0 ? ` with ${filters.join(' · ')}` : '';
  if (searching && incomplete)
    hint.push(
      `Nothing matched “${excerpt}”${within} in what has loaded for the ${total} ${noun}.`,
    );
  else if (searching && filters.length > 0)
    hint.push(
      `Search “${excerpt}” in ${scope}${within} leaves none of the ${total} loaded ${noun}.`,
    );
  else if (searching)
    hint.push(`Searched ${scope} across ${total} loaded ${noun}.`);
  else
    hint.push(`None of the ${total} loaded ${noun}: ${filters.join(' · ')}.`);
  if (loading.length > 0)
    hint.push(`${cap(listJoin(loading))} are not searched until they load.`);
  if (failed.length > 0)
    hint.push(`${cap(listJoin(failed))} failed to load and were not searched.`);
  if (stale.length > 0)
    hint.push(`Searched the last loaded ${listJoin(stale)} (refresh failed).`);

  return wrap(
    <EmptyState
      icon={icon}
      title={title}
      hint={hint.join(' ')}
      action={
        <div className="flex flex-wrap justify-center gap-2">
          <Button variant="secondary" className="min-h-11" onClick={onReset}>
            Show all {noun}
          </Button>
          {retryable.length > 0 && (
            <Button
              variant="secondary"
              className="min-h-11"
              aria-label={`Retry loading ${listJoin(
                retryable.map((x) => x.label),
              )}`}
              onClick={() => {
                for (const x of retryable) void x.l.query.refetch();
              }}
            >
              Retry
            </Button>
          )}
        </div>
      }
    />,
  );
}

/** The quoted query excerpt is bounded (32 chars) but may be one unbroken
 *  token wider than 320px: let it break here, scoped to Books. */
const wrap = (node: ReactNode) => (
  <div className="min-w-0 max-w-full [overflow-wrap:anywhere]">{node}</div>
);

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** Restrictions a Books segment actually applied: the status/segment filter
 *  labels given plus a date bound that parsed and was not reversed. */
export function effectiveDateFilter(
  order: { from: string | null; to: string | null },
  dateLabel: string | undefined,
): string[] {
  return order.from !== null || order.to !== null
    ? [dateLabel ?? 'Date range']
    : [];
}
