import { useEffect, useId, useRef, useState } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import { ActiveFilters } from '../books/chips';
import { useSetFilterParam } from '../books/filters';
import { DocThumbLightbox } from './DocThumbLightbox';
import { signedEuros } from '../lib/money';
import { useReturnPosition } from '../lib/listPosition';
import { searchNeedle } from '../lib/searchText';
import { useOriginState } from '../lib/returnNavigation';
import { useSeg } from '../lib/useSeg';
import { relativeTime } from '../relativeTime';
import { LargeTitleHeader } from '../shell/Headers';
import {
  splitTodayEarlier,
  useInboxQueue,
  approvalDisplay,
  useInboxHero,
  type InboxEntry,
  type InboxSegment,
} from '../queries/inbox';
import { useEntities, useExpenses, useInvoices } from '../queries/shared';
import { AmountText } from '../ui/AmountText';
import { Chip } from '../ui/Chip';
import { EmptyState, SkeletonRows } from '../ui/Feedback';
import { ListGroup, ListRow } from '../ui/List';
import { LoadError } from '../ui/LoadError';
import { SearchInput } from '../ui/SearchInput';
import { SegmentedControl } from '../ui/SegmentedControl';
import { UploadDocumentSheet } from '../upload/UploadDocumentSheet';
import { useSheet } from '../lib/useSheet';
import {
  humanizePolicyReason,
  triageChipLabel,
  triageSubtitle,
} from './reason';
import { runState, segmentLabel } from './queueRun';
import { INBOX_SEARCH, inboxEntryMatches, titleOnlyApproval } from './search';

const SEGMENTS: readonly InboxSegment[] = ['all', 'triage', 'approvals'];

/** The fallback reason glyph — used directly for approval rows (no document
 *  id to fetch a thumbnail for) and as DocThumb's `fallback` for triage rows
 *  (no preview / non-visual document). */
function ReasonGlyph({ entry }: { entry: InboxEntry }) {
  const [bg, glyph] =
    entry.kind === 'approval'
      ? ['bg-tint text-accent', '✓']
      : entry.item.reason_type === 'ocr_failed' ||
          entry.item.reason_type === 'not_a_document'
        ? ['bg-err-bg text-err', '!']
        : ['bg-warn-bg text-warn', '?'];
  return (
    <span
      aria-hidden
      className={`flex h-[34px] w-[34px] flex-none items-center justify-center rounded-[10px] text-[15px] font-bold ${bg}`}
    >
      {glyph}
    </span>
  );
}

function QueueRow({
  entry,
  facts,
  run,
}: {
  entry: InboxEntry;
  facts: Parameters<typeof approvalDisplay>[1];
  /** null: a search result — opened as a single item (issue #278). */
  run: ReturnType<typeof runState> | null;
}) {
  // Opening an item records this Inbox entry as its origin (issue #252)
  // and starts a queue run over the visible segment (issue #253). A search
  // hit starts no run: "next" would be an item the operator never picked.
  const origin = { ...run, ...useOriginState() };
  if (entry.kind === 'triage') {
    return (
      <ListRow
        to={entry.route}
        state={origin}
        positionRow
        leading={
          <DocThumbLightbox
            id={entry.item.id}
            className="h-[34px] w-[34px] rounded-[10px] border border-line"
            fallback={<ReasonGlyph entry={entry} />}
          />
        }
        title={entry.item.filename}
        subtitle={triageSubtitle(entry.item)}
        chip={
          <Chip tone="warn">{triageChipLabel(entry.item.reason_type)}</Chip>
        }
        trailing={
          <div className="text-[12px] text-ink-2">
            {relativeTime(entry.item.created_at)}
          </div>
        }
      />
    );
  }
  const d = approvalDisplay(entry.approval, facts);
  return (
    <ListRow
      to={entry.route}
      state={origin}
      positionRow
      leading={<ReasonGlyph entry={entry} />}
      title={d.title}
      subtitle={humanizePolicyReason(entry.approval.policy_reason)}
      chip={<Chip tone="accent">approve?</Chip>}
      trailing={
        <div className="flex-none">
          {d.amountCents != null && (
            <AmountText
              cents={d.amountCents}
              showSign
              className="block whitespace-nowrap text-[14px]"
            />
          )}
          <div className="text-[12px] text-ink-2">
            {relativeTime(entry.approval.created_at)}
          </div>
        </div>
      }
    />
  );
}

function InboxHero({
  periodName,
  monthTotalCents,
  taskCount,
  firstRoute,
  run,
  searchingIn,
}: {
  periodName: string;
  monthTotalCents: number;
  taskCount: number;
  firstRoute: string | null;
  run: ReturnType<typeof runState>;
  /** The segment's label while a search is active: the CTA still starts
   *  the whole unfiltered queue, and says so. */
  searchingIn: string | null;
}) {
  const origin = { ...run, ...useOriginState() };
  return (
    <div className="mx-3.5 mb-3.5 rounded-2xl bg-accent-deep px-5 py-4 text-white">
      <p className="text-[11px] font-bold uppercase tracking-wide opacity-70">
        {periodName} · open
      </p>
      <p className="mt-1 whitespace-nowrap text-[28px] font-extrabold tabular-nums">
        {signedEuros(-monthTotalCents)}
      </p>
      <p className="text-[12.5px] opacity-70">expenses this period</p>
      {taskCount > 0 && firstRoute !== null && (
        // The mint hero CTA is the ONE sanctioned bespoke button (spec:
        // `signal` token is hero-CTA-only).
        <Link
          to={firstRoute}
          state={origin}
          className="mt-3 block rounded-xl bg-signal px-4 py-2.5 text-center text-[15px] font-bold text-accent-deep"
        >
          Start clearing · {taskCount}
        </Link>
      )}
      {taskCount > 0 && firstRoute !== null && searchingIn !== null && (
        <p className="mt-1.5 text-center text-[11.5px] opacity-80">
          Whole {searchingIn} queue — ignores the search
        </p>
      )}
    </div>
  );
}

/** /inbox — the unified decision queue: needs-triage documents + pending
 *  approvals, ONE FIFO list (oldest on top — the queue must end). Polls at
 *  30s while mounted; see queries/inbox.ts for the polling rule. */
export function InboxScreen() {
  const [params] = useSearchParams();
  const [seg, setSeg] = useSeg<InboxSegment>(SEGMENTS, 'all');
  const q = params.get('q') ?? '';
  const needle = searchNeedle(q);
  const search = INBOX_SEARCH[seg];
  const searchId = useId();
  const scopeId = useId();
  const setParam = useSetFilterParam();
  // Clear moves focus back to the field (its summary bar unmounts).
  const [focusSearch, setFocusSearch] = useState(false);
  useEffect(() => {
    if (!focusSearch) return;
    setFocusSearch(false);
    document.getElementById(searchId)?.focus({ preventScroll: true });
  }, [focusSearch, searchId]);
  const clearSearch = () => {
    setParam('q', null);
    setFocusSearch(true);
  };
  const { entries, counts, triageQ, approvalsQ, isPending } = useInboxQueue(
    seg,
    { poll: true },
  );
  const hero = useInboxHero();
  // Back from an opened item lands on its row again (issue #355): once
  // BOTH queue lists are loaded. While either has failed (LoadError above
  // any cached rows) the return waits; its Retry places the row again. The
  // approval names and amounts, the hero and thumbnails only re-anchor as
  // they arrive.
  const rootRef = useRef<HTMLDivElement>(null);
  useReturnPosition(rootRef, triageQ.isSuccess && approvalsQ.isSuccess);
  // The same upload flow as Books (issue #258).
  const uploadSheet = useSheet();
  const expensesQ = useExpenses();
  const invoicesQ = useInvoices();
  const entitiesQ = useEntities();
  const facts = {
    expenses: expensesQ.data ?? [],
    invoices: invoicesQ.data ?? [],
    entities: entitiesQ.data ?? [],
  };
  const all = splitTodayEarlier(entries);
  // The UNFILTERED rows — Earlier, then Today — are the run's snapshot
  // order (issue #253); "Start clearing" opens its first member. A search
  // (issue #278) never changes that queue: it only narrows what is listed.
  const ordered = [...all.earlier, ...all.today];
  const run = runState(seg, ordered);
  const shown =
    needle === null
      ? entries
      : entries.filter((e) => inboxEntryMatches(e, needle, facts));
  const { today, earlier } = needle === null ? all : splitTodayEarlier(shown);
  const rowRun = needle === null ? run : null;
  const total = counts.triage + counts.approvals;
  const listError = triageQ.error ?? approvalsQ.error;
  // Approval rows are named and priced from these lists: while they are
  // missing, an approval can only match by its arrival date or title.
  const factsMissing =
    needle !== null &&
    seg !== 'triage' &&
    counts.approvals > 0 &&
    (expensesQ.data === undefined ||
      invoicesQ.data === undefined ||
      entitiesQ.data === undefined);
  // Loaded once, but the latest refresh failed: the search uses the last
  // loaded names and amounts.
  const factsStale =
    needle !== null &&
    !factsMissing &&
    seg !== 'triage' &&
    counts.approvals > 0 &&
    (expensesQ.isError || invoicesQ.isError || entitiesQ.isError);
  const titleOnly =
    needle === null ? 0 : entries.filter(titleOnlyApproval).length;

  // Legacy /intake?expand=N deep link (redirect chain preserves the param).
  const expand = params.get('expand');
  if (expand !== null && /^\d+$/.test(expand)) {
    return <Navigate to={`/inbox/doc/${expand}`} replace />;
  }

  return (
    <div ref={rootRef} className="mx-auto max-w-3xl pb-6">
      <LargeTitleHeader
        title="Inbox"
        trailing={
          <div className="flex items-center gap-3">
            <span className="text-[12.5px] font-semibold text-ink-2">
              {total === 1 ? '1 task' : `${total} tasks`}
            </span>
            <button
              type="button"
              onClick={() => uploadSheet.open()}
              className="text-[15px] font-semibold text-accent"
            >
              Upload
            </button>
          </div>
        }
      />
      <div className="space-y-2.5 px-4 pb-3">
        <SegmentedControl
          label="Inbox filter"
          options={[
            { value: 'all' as const, label: 'All' },
            { value: 'triage' as const, label: `Triage ${counts.triage}` },
            {
              value: 'approvals' as const,
              label: `Approvals ${counts.approvals}`,
            },
          ]}
          value={seg}
          onChange={setSeg}
        />
        <SearchInput
          id={searchId}
          value={q}
          onChange={(v) => setParam('q', v === '' ? null : v)}
          placeholder={search.placeholder}
          aria-label="Search the Inbox"
          aria-describedby={scopeId}
        />
        <span id={scopeId} className="sr-only">
          Matches {search.scope}. Results open one at a time, outside the queue.
        </span>
      </div>
      <ActiveFilters
        filters={[]}
        q={q}
        searchScope={search.scope}
        result={
          isPending || listError != null
            ? undefined
            : { shown: shown.length, total: entries.length, noun: 'tasks' }
        }
        onReset={clearSearch}
        resetLabel="Clear"
        resetName="Clear search"
      />
      {factsMissing && (
        <p className="px-4 pb-2 text-[12px] text-warn">
          {expensesQ.isError || invoicesQ.isError || entitiesQ.isError
            ? 'Approval names and amounts failed to load'
            : 'Approval names and amounts are still loading'}{' '}
          — approvals can only match by arrival date or title for now.
        </p>
      )}
      {factsStale && (
        <p className="px-4 pb-2 text-[12px] text-warn">
          Approval names and amounts failed to refresh — the search uses the
          last loaded ones.
        </p>
      )}
      {titleOnly > 0 && (
        <p className="px-4 pb-2 text-[12px] text-ink-2">
          {titleOnly === 1
            ? '1 approval (bank match or other) is'
            : `${titleOnly} approvals (bank match or other) are`}{' '}
          searched by title and arrival date only — not by amount or
          counterparty.
        </p>
      )}
      {hero !== null && (
        <InboxHero
          periodName={hero.periodName}
          monthTotalCents={hero.monthTotalCents}
          taskCount={entries.length}
          firstRoute={ordered[0]?.route ?? null}
          run={run}
          searchingIn={needle === null ? null : segmentLabel(seg)}
        />
      )}
      {isPending && <SkeletonRows count={4} />}
      {listError != null && (
        <LoadError
          message={
            listError instanceof Error
              ? listError.message
              : 'Failed to load the queue'
          }
          onRetry={() => {
            void triageQ.refetch();
            void approvalsQ.refetch();
          }}
        />
      )}
      {!isPending && listError == null && entries.length === 0 && (
        <EmptyState
          icon="🎉"
          title="Inbox zero"
          hint="Nothing needs a decision right now."
        />
      )}
      {!isPending &&
        needle !== null &&
        entries.length > 0 &&
        shown.length === 0 && (
          <EmptyState
            icon="⌕"
            title="No tasks match"
            hint={`${
              listError != null ? 'Searched only the tasks that loaded. ' : ''
            }The search looks at ${search.scope}.`}
            action={
              <button
                type="button"
                onClick={clearSearch}
                className="min-h-11 text-[14px] font-semibold text-accent"
              >
                Clear search
              </button>
            }
          />
        )}
      {earlier.length > 0 && (
        <ListGroup label={`Earlier · ${earlier.length}`}>
          {earlier.map((e) => (
            <QueueRow key={e.route} entry={e} facts={facts} run={rowRun} />
          ))}
        </ListGroup>
      )}
      {today.length > 0 && (
        <ListGroup label={`Today · ${today.length}`}>
          {today.map((e) => (
            <QueueRow key={e.route} entry={e} facts={facts} run={rowRun} />
          ))}
        </ListGroup>
      )}
      {shown.length > 0 && (
        <p className="pb-2 text-center text-[10.5px] text-ink-2">
          Oldest first — the queue clears FIFO
        </p>
      )}
      {/* Remount-on-open (epoch key), as in Books. */}
      {uploadSheet.epoch > 0 && (
        <UploadDocumentSheet
          key={`upload-${uploadSheet.epoch}`}
          open={uploadSheet.isOpen}
          onOpenChange={(o) => !o && uploadSheet.close()}
        />
      )}
    </div>
  );
}
