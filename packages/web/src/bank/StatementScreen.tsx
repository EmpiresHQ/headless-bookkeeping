import { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { deleteBankStatement, fmtCents } from '../api';
import {
  errorMessage,
  usePendingOperation,
  useSessionTask,
} from '../lib/pendingOperation';
import {
  useResultLog,
  slotHandle,
  useReceipt,
  writeChain,
  type ChainSlot,
  type ResultHandle,
  type ResultInit,
} from '../lib/resultLog';
import type { MatchProposalView, MatchRowView } from '../api';
import {
  BookingPartialError,
  bankKeys,
  bookProposals,
  confirmStagedMatch,
  invalidateStatement,
  undoMatches,
  useBankStatements,
  useBankTransactions,
  useMatchProposals,
  useReconciliation,
  useStatementMatches,
} from '../queries/bank';
import { ActiveFilters } from '../books/chips';
import { useSetFilterParam } from '../books/filters';
import {
  KEEPS_POSITION,
  POSITION_GROUP,
  POSITION_ROW,
  useReturnPosition,
} from '../lib/listPosition';
import { searchNeedle } from '../lib/searchText';
import { AmountText } from '../ui/AmountText';
import { Button } from '../ui/Button';
import { Chip } from '../ui/Chip';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { EmptyState, SkeletonRows } from '../ui/Feedback';
import { GroupLabel, ROW_BODY, ROW_IDENTITY, ROW_TRAILING } from '../ui/List';
import { SearchInput } from '../ui/SearchInput';
import { SegmentedControl } from '../ui/SegmentedControl';
import { toastErr, toastUndo } from '../ui/toast';
import { ScreenHeader } from '../shell/Headers';
import {
  useCompletionNavigation,
  useOriginState,
} from '../lib/returnNavigation';
import { formatStatementPeriod, formatTxDate, txTitle } from './format';
import { LoadError } from './LoadError';
import { undoIncomplete } from './lineResults';
import { STATEMENT_SEARCH, lineMatches } from './search';
import {
  bucketOf,
  buildLines,
  proposalKey,
  type LineView,
} from './statementModel';

const DISPOSITION_LABEL: Record<string, string> = {
  personal: 'personal',
  prepayment: 'prepayment',
  bank_fee: 'bank fee',
  dividend: 'dividend',
};

/** A line's navigation control for the list return (issue #355): `id` names
 *  this exact opener (a line can show several — one per proposal or staged
 *  match); the line groups them, so a return whose exact control is gone
 *  lands on another of the line's. Never on a checkbox or Confirm. */
function opener(line: LineView, id?: string) {
  const group = `tx:${line.tx.id}`;
  return {
    [POSITION_ROW]: id === undefined ? group : `${group}:${id}`,
    [POSITION_GROUP]: group,
  };
}

/** Line amount + date, right-aligned, never wrapping. */
function LineTrailing({ line, muted }: { line: LineView; muted?: boolean }) {
  return (
    <div className={ROW_TRAILING}>
      <AmountText
        cents={line.tx.amount}
        currency={line.tx.currency}
        showSign={!muted}
        className={`block text-[14px] ${muted ? 'text-ink-2' : ''}`}
      />
      <div className="text-[12px] text-ink-2">
        {formatTxDate(line.tx.transaction_date)}
      </div>
    </div>
  );
}

/** "Decide yourself" row — plain navigation row. */
function DecideRow({ line, onOpen }: { line: LineView; onOpen: () => void }) {
  const partial = line.recon?.reconStatus === 'partial';
  return (
    <button
      type="button"
      onClick={onOpen}
      {...opener(line)}
      className="flex w-full items-center gap-3 border-b border-line px-3.5 py-3 text-left last:border-b-0"
    >
      <div className={ROW_BODY}>
        <div className={ROW_IDENTITY}>
          <div className="text-[14.5px] font-semibold">{txTitle(line.tx)}</div>
          <div className="text-[12.5px] text-ink-2">
            {partial
              ? `Partially matched · ${fmtCents(line.recon?.remaining ?? 0)} € left`
              : 'No AI match — decide'}
          </div>
        </div>
        <LineTrailing line={line} />
      </div>
      <span aria-hidden className="flex-none text-base text-chevron">
        ›
      </span>
    </button>
  );
}

/** AI-proposals row — selectable checkbox per proposal, staged drafts get a
 *  "staged" chip and a per-row Confirm button. */
function ProposalRow({
  line,
  selected,
  onToggle,
  onOpen,
  onConfirmStaged,
  confirmBusy,
}: {
  line: LineView;
  selected: Set<string>;
  onToggle: (p: MatchProposalView) => void;
  onOpen: () => void;
  onConfirmStaged: (m: MatchRowView) => void;
  confirmBusy: boolean;
}) {
  return (
    <div className="border-b border-line last:border-b-0">
      {line.proposals.map((p) => {
        const key = proposalKey(p);
        const on = selected.has(key);
        return (
          <div key={key} className="flex w-full items-center gap-3 px-3.5 py-3">
            <button
              type="button"
              role="checkbox"
              aria-checked={on}
              aria-label={`Select match ${p.objectLabel}`}
              onClick={() => onToggle(p)}
              // 44×44 touch box around the 22px visual (#273); -m-[11px]
              // keeps the 22px layout footprint so it ends 1px short of
              // the detail button and never overlaps it.
              className="-m-[11px] flex h-11 w-11 flex-none items-center justify-center"
            >
              <span
                className={`flex h-[22px] w-[22px] items-center justify-center rounded-[7px] border-2 text-[13px] font-bold ${
                  on
                    ? 'border-accent bg-accent text-white'
                    : 'border-chevron text-transparent'
                }`}
              >
                ✓
              </span>
            </button>
            <button
              type="button"
              onClick={onOpen}
              {...opener(line, `proposal:${key}`)}
              className="flex min-h-11 min-w-0 flex-1 items-center gap-3 text-left"
            >
              <div className={ROW_BODY}>
                <div className={ROW_IDENTITY}>
                  <div className="text-[14.5px] font-semibold">
                    {txTitle(line.tx)}
                  </div>
                  <div className="text-[12.5px] text-ink-2">
                    → {p.objectLabel} <Chip tone="warn">{p.confidence}</Chip>
                  </div>
                </div>
                <LineTrailing line={line} />
              </div>
            </button>
          </div>
        );
      })}
      {line.staged.map((m) => (
        <div key={m.id} className="flex w-full items-center gap-3 px-3.5 py-3">
          <button
            type="button"
            onClick={onOpen}
            {...opener(line, `staged:${m.id}`)}
            className="flex min-h-11 min-w-0 flex-1 items-center gap-3 text-left"
          >
            <div className={ROW_BODY}>
              <div className={ROW_IDENTITY}>
                <div className="text-[14.5px] font-semibold">
                  {txTitle(line.tx)}
                </div>
                <div className="text-[12.5px] text-ink-2">
                  → {m.objectLabel} <Chip tone="warn">staged</Chip>
                </div>
              </div>
              <LineTrailing line={line} />
            </div>
          </button>
          <Button
            variant="secondary"
            className="min-h-11 flex-none px-3 py-1.5 text-[12px]"
            busy={confirmBusy}
            onClick={() => onConfirmStaged(m)}
          >
            Confirm
          </Button>
        </div>
      ))}
    </div>
  );
}

/** Done row — matched (green stripe + ✓ + dimmed) or a disposition chip. */
function DoneRow({ line, onOpen }: { line: LineView; onOpen: () => void }) {
  const disposed = line.tx.status !== 'open';
  return (
    <button
      type="button"
      onClick={onOpen}
      {...opener(line)}
      className={`flex w-full items-center gap-3 border-b border-line px-3.5 py-3 text-left last:border-b-0 ${
        disposed
          ? ''
          : // sanctioned one-off (approved mockup), no token — Plan 06 Task 2
            'bg-[#F5FAF6] shadow-[inset_3px_0_0_theme(colors.ok.DEFAULT)]'
      }`}
    >
      {!disposed && (
        <span
          aria-hidden
          className="flex h-[34px] w-[34px] flex-none items-center justify-center rounded-[10px] bg-ok-bg font-extrabold text-ok"
        >
          ✓
        </span>
      )}
      <div className={ROW_BODY}>
        <div className={ROW_IDENTITY}>
          <div className="text-[14.5px] font-semibold text-ink-2">
            {txTitle(line.tx)}
          </div>
          {disposed ? (
            <div className="mt-0.5">
              <Chip>{DISPOSITION_LABEL[line.tx.status] ?? line.tx.status}</Chip>
            </div>
          ) : (
            <div className="text-[12.5px] text-ink-2">
              → {line.active.map((m) => m.objectLabel).join(' · ')}
            </div>
          )}
        </div>
        <LineTrailing line={line} muted />
      </div>
    </button>
  );
}

export function StatementScreen() {
  const params = useParams();
  const statementId = Number(params.id);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  // Issue #252: opening a line records this statement as its origin; a
  // finished line / a deleted statement returns to its own origin entry.
  const origin = useOriginState();
  const { returnTo } = useCompletionNavigation();
  const seg = searchParams.get('seg') === 'all' ? 'all' : 'unmatched';
  // Search inside the statement (issue #278): ?q= narrows the listed lines
  // only — counts, the selection and its preselect are the statement's.
  const q = searchParams.get('q') ?? '';
  const needle = searchNeedle(q);
  const searchId = useId();
  const scopeId = useId();
  const setParam = useSetFilterParam();
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

  const statementsQ = useBankStatements();
  const txQ = useBankTransactions(statementId);
  const reconQ = useReconciliation(statementId);
  const matchesQ = useStatementMatches(statementId);
  const proposalsQ = useMatchProposals(statementId);

  const [deleteOpen, setDeleteOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // One operation at a time on this screen (issue #251); `running` only
  // says which control shows the progress.
  const op = usePendingOperation('Bank statement');
  const sessionTask = useSessionTask();
  const [running, setRunning] = useState<'book' | 'confirm' | 'delete'>('book');
  const deleting = op.pending && running === 'delete';
  // The booking request as captured at click: while it is pending the Book
  // button shows exactly it (issue #278), whatever the selection does.
  const [bookingShown, setBookingShown] = useState<{
    count: number;
    netCents: number;
    searched: boolean;
  } | null>(null);
  const booking = op.pending;
  const confirmBusy = op.pending;

  // Pre-select high-confidence proposals on the FIRST proposals load per
  // statement only. Refetches (every invalidateStatement) must NOT resurrect
  // manually deselected proposals — that would silently change the Book count
  // on a money-moving control. Navigating to another statement re-arms it.
  const preselectedFor = useRef<number | null>(null);
  useEffect(() => {
    if (preselectedFor.current !== statementId && proposalsQ.data) {
      preselectedFor.current = statementId;
      setSelected(
        new Set(
          proposalsQ.data
            .filter((p) => p.confidence === 'high')
            .map(proposalKey),
        ),
      );
    }
  }, [statementId, proposalsQ.data]);

  const statement = statementsQ.data?.find((s) => s.id === statementId);
  const lines = useMemo(
    () =>
      buildLines(
        txQ.data ?? [],
        reconQ.data ?? [],
        matchesQ.data ?? [],
        proposalsQ.data ?? [],
      ),
    [txQ.data, reconQ.data, matchesQ.data, proposalsQ.data],
  );
  const loading = txQ.isPending || reconQ.isPending || matchesQ.isPending;
  // reconQ/matchesQ errors mean the worklist buckets (proposals/decide/done)
  // are computed on incomplete data — a silent dump into "Decide yourself"
  // is misleading, so they gate the full-screen error the same as txQ.
  const failingQuery = txQ.isError
    ? txQ
    : reconQ.isError
      ? reconQ
      : matchesQ.isError
        ? matchesQ
        : null;
  const hasBlockingError = failingQuery !== null;
  // Back from an opened line lands on its control again (issue #355): once
  // the lines, their reconciliation and matches are loaded (a failure shows
  // LoadError; its Retry restores the line again) and the AI proposals have
  // answered — they decide which bucket and row a line shows in. A failed
  // proposals read still shows every line; its Retry re-anchors.
  const rootRef = useRef<HTMLDivElement>(null);
  useReturnPosition(
    rootRef,
    txQ.isSuccess &&
      reconQ.isSuccess &&
      matchesQ.isSuccess &&
      !proposalsQ.isPending,
  );

  const toggleProposal = (p: MatchProposalView) =>
    setSelected((prev) => {
      const next = new Set(prev);
      const key = proposalKey(p);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const proposalLines = lines.filter((l) => bucketOf(l) === 'proposals');
  const decideLines = lines.filter((l) => bucketOf(l) === 'decide');
  const doneLines = lines.filter((l) => bucketOf(l) === 'done');
  const unmatchedCount = proposalLines.length + decideLines.length;
  const shownOf = (ls: LineView[]) =>
    needle === null ? ls : ls.filter((l) => lineMatches(l, needle));
  const shownProposals = shownOf(proposalLines);
  const shownDecide = shownOf(decideLines);
  const shownDone = seg === 'all' ? shownOf(doneLines) : [];
  const shownCount =
    shownProposals.length + shownDecide.length + shownDone.length;
  const segCount = seg === 'all' ? lines.length : unmatchedCount;

  // Bulk booking books ONLY what is on screen (issue #278): a selected
  // proposal hidden by the search stays selected (Clear shows it again) but
  // is never part of the request. Unfiltered, this is every selection.
  const shownTx = new Set(shownProposals.map((l) => l.tx.id));
  const allChosen = (proposalsQ.data ?? []).filter((p) =>
    selected.has(proposalKey(p)),
  );
  const chosen = allChosen.filter((p) => shownTx.has(p.bankTransactionId));
  // Hidden BY THE SEARCH: selections on lines still awaiting a proposal
  // decision that the search leaves off screen — never a stale proposal on
  // a line that is done meanwhile.
  const eligibleTx = new Set(proposalLines.map((l) => l.tx.id));
  const hiddenChosen =
    needle === null
      ? 0
      : allChosen.filter((p) => eligibleTx.has(p.bankTransactionId)).length -
        chosen.length;
  const txById = new Map(lines.map((l) => [l.tx.id, l.tx]));
  const netCents = chosen.reduce((sum, p) => {
    const tx = txById.get(p.bankTransactionId);
    return sum + (tx && tx.amount < 0 ? -p.amountMatched : p.amountMatched);
  }, 0);

  const bookButton =
    booking && running === 'book' && bookingShown !== null
      ? { ...bookingShown, pending: true }
      : {
          count: chosen.length,
          netCents,
          searched: needle !== null,
          pending: false,
        };

  // Durable receipts of bookings on this statement (#259).
  const log = useResultLog();
  const bookRecord = useRef<ChainSlot['current']>(null);
  const writeReceipt = useReceipt();
  const statementTitle = statement
    ? `Statement ${formatStatementPeriod(statement.start_date, statement.end_date)}`
    : `Statement #${statementId}`;
  const statementLinks = [
    { label: 'Statement', to: `/bank/statements/${statementId}` },
  ];

  /** Undo toast for matches booked in THIS session only. */
  const offerUndo = (
    label: string,
    matchIds: number[],
    record: ResultHandle | null,
  ) => {
    const undo = sessionTask();
    let removed = 0;
    toastUndo(label, () =>
      undo(
        (stage) =>
          undoMatches(statementId, matchIds, stage, (n) => {
            removed = n;
            if (n < matchIds.length)
              record?.update({
                action: 'Match · undoing',
                outcome: `Undo in progress: ${n} of ${matchIds.length} matches removed so far.`,
                tone: 'running',
              });
          }).then(() => {
            stage();
            record?.update({
              action: 'Match · undone',
              outcome: `${label} — undone; ${matchIds.length === 1 ? 'the match was' : 'those matches were'} removed.`,
              tone: 'ok',
            });
            return invalidateStatement(qc, statementId);
          }),
        {
          onSuccess: () => undefined,
          onError: (e) => {
            toastErr(e instanceof Error ? e.message : String(e));
            // The receipt must not keep saying "booked" (#259).
            record?.update({
              action: 'Match · undo incomplete',
              outcome: undoIncomplete(removed, matchIds.length, e),
              tone: 'partial',
            });
            void invalidateStatement(qc, statementId);
          },
        },
      ),
    );
  };

  const onBook = () => {
    const proposals = chosen;
    const captured = {
      count: chosen.length,
      netCents,
      searched: needle !== null,
    };
    // One record per booking series: staged → each activation → outcome;
    // a retry after a failure supersedes it.
    const note = (
      tone: ResultInit['tone'],
      outcome: string,
      live?: () => boolean,
    ) => {
      const init = {
        action: 'Book matches',
        title: statementTitle,
        outcome,
        tone,
        links: statementLinks,
      };
      writeChain(bookRecord, log.record, init, live);
    };
    const plural = (n: number) => `${n} ${n === 1 ? 'match' : 'matches'}`;
    let accepted = false;
    const started = op.run(
      async (ctx) => {
        const matchIds = await bookProposals(
          statementId,
          proposals,
          ctx.check,
          {
            staged: (ids) => {
              accepted = true;
              note(
                'running',
                `${plural(ids.length)} staged — approving them; their approval is not confirmed yet.`,
                ctx.live,
              );
            },
            approved: (done, staged) =>
              note(
                'running',
                `${done.length} of ${plural(staged.length)} approved and active — approving the rest…`,
                ctx.live,
              ),
          },
        );
        ctx.check();
        note('ok', `Booked ${plural(matchIds.length)}.`, ctx.live);
        await invalidateStatement(qc, statementId);
        return matchIds;
      },
      {
        onSuccess: (matchIds) => {
          setBookingShown(null);
          const record = slotHandle(bookRecord);
          // A new booking is a new record.
          bookRecord.current = null;
          offerUndo(`Booked ${plural(matchIds.length)}`, matchIds, record);
        },
        onError: (e) => {
          setBookingShown(null);
          if (!accepted) {
            // No staging was confirmed: nothing is claimed either way.
            note(
              'error',
              `Booking ${plural(proposals.length)} was not confirmed (${errorMessage(e)}). Open the statement for its current state before booking again.`,
            );
          } else if (e instanceof BookingPartialError) {
            const active = e.approvedMatchIds.length;
            const staged = e.stagedMatchIds.length;
            note(
              'partial',
              `${active} of ${plural(staged)} approved and active; approval of the rest was not confirmed (${errorMessage(e.cause)}). Open the statement — confirm any match still staged.`,
            );
          }
          // Server-enforced cap / over-match — show the server's words, then
          // refresh so partially staged/active state is visible, never
          // hidden.
          toastErr(e instanceof Error ? e.message : String(e));
          void invalidateStatement(qc, statementId);
        },
      },
    );
    if (started) {
      setRunning('book');
      setBookingShown(captured);
    }
  };

  const onConfirmStaged = (m: MatchRowView) => {
    const links = [
      {
        label: 'Bank line',
        to: `/bank/statements/${statementId}/tx/${m.bankTransactionId}`,
      },
      ...statementLinks,
    ];
    let accepted = false;
    let confirmed: ResultHandle | null = null;
    const started = op.run(
      async (ctx) => {
        await confirmStagedMatch(m.id, ctx.check);
        accepted = true;
        ctx.check();
        confirmed = writeReceipt(
          `confirm:${m.id}`,
          {
            action: 'Confirm match',
            title: statementTitle,
            outcome: `Staged match to ${m.objectLabel} confirmed · ${fmtCents(m.amountMatched)} €`,
            tone: 'ok',
            links,
          },
          ctx.live,
        );
        await invalidateStatement(qc, statementId);
      },
      {
        onSuccess: () =>
          offerUndo(`Confirmed · ${m.objectLabel}`, [m.id], confirmed),
        onError: (e) => {
          if (!accepted)
            writeReceipt(`confirm:${m.id}`, {
              action: 'Confirm match',
              title: statementTitle,
              outcome: `Confirming the staged match to ${m.objectLabel} was not confirmed (${errorMessage(e)}). Open the line for its current state.`,
              tone: 'error',
              links,
            });
          // "No pending approval found" means the screen is stale — a
          // refetch self-heals (the draft may already be active or gone).
          toastErr(e instanceof Error ? e.message : String(e));
          void invalidateStatement(qc, statementId);
        },
      },
    );
    if (started) setRunning('confirm');
  };

  const onDelete = () => {
    const started = op.run(
      async (ctx) => {
        await deleteBankStatement(statementId);
        ctx.check();
        // Deleting a statement unlinks matches / un-reconciles expenses —
        // the same cross-domain staleness class P04 fixed for line-level
        // actions: fan out via invalidateStatement PLUS the list key.
        await Promise.all([
          qc.invalidateQueries({ queryKey: bankKeys.statements }),
          invalidateStatement(qc, statementId),
        ]);
      },
      {
        onSuccess: () => {
          setDeleteOpen(false);
          returnTo({ fallback: '/bank', acceptOrigin: (p) => p === '/bank' });
        },
        onError: (e) => {
          toastErr(e instanceof Error ? e.message : String(e));
          setDeleteOpen(false);
        },
      },
    );
    if (started) setRunning('delete');
  };

  const openTx = (txId: number) =>
    navigate(
      `/bank/statements/${statementId}/tx/${txId}${seg === 'all' ? '?seg=all' : ''}`,
      { state: origin },
    );

  return (
    <div ref={rootRef} className="mx-auto max-w-3xl pb-28">
      <ScreenHeader
        title={
          statement
            ? formatStatementPeriod(statement.start_date, statement.end_date)
            : 'Statement'
        }
        backTo="/bank"
        trailing={
          <button
            type="button"
            onClick={() => setDeleteOpen(true)}
            className="text-[13px] font-semibold text-err"
          >
            Delete
          </button>
        }
      />
      <div className="space-y-2.5 px-4 pb-3">
        <SegmentedControl
          label="Bank lines"
          options={[
            { value: 'unmatched', label: `Unmatched ${unmatchedCount}` },
            { value: 'all', label: `All ${lines.length}` },
          ]}
          value={seg}
          // No list change under a pending operation (issue #278): the
          // shown rows and Book figures stay those of the request.
          disabled={op.pending}
          onChange={(v) => {
            // In place: keep this entry's own origin record (issue #252)
            // and every other param — the search survives (issue #278).
            const next = new URLSearchParams(searchParams);
            if (v === 'all') next.set('seg', 'all');
            else next.delete('seg');
            setSearchParams(next, {
              replace: true,
              state: location.state as unknown,
            });
          }}
        />
        <SearchInput
          id={searchId}
          value={q}
          onChange={(v) => setParam('q', v === '' ? null : v)}
          placeholder={STATEMENT_SEARCH.placeholder}
          aria-label="Search this statement"
          aria-describedby={scopeId}
          disabled={op.pending}
        />
        <span id={scopeId} className="sr-only">
          Matches {STATEMENT_SEARCH.scope}. Book matches books only the selected
          matches shown.
        </span>
      </div>
      <ActiveFilters
        filters={[]}
        q={q}
        searchScope={STATEMENT_SEARCH.scope}
        result={
          loading || hasBlockingError
            ? undefined
            : { shown: shownCount, total: segCount, noun: 'lines' }
        }
        onReset={clearSearch}
        resetLabel="Clear"
        resetName="Clear search"
        resetDisabled={op.pending}
      />

      {loading && <SkeletonRows count={5} />}
      {failingQuery && (
        <LoadError
          message={
            failingQuery.error instanceof Error
              ? failingQuery.error.message
              : 'Failed to load this statement'
          }
          onRetry={() => void failingQuery.refetch()}
        />
      )}

      {!loading && !hasBlockingError && (
        <>
          {proposalsQ.isError && (
            <div className="mx-3.5 mb-3.5 flex items-center justify-between gap-3 rounded-xl bg-warn-bg px-3.5 py-2.5 text-[12.5px] text-warn">
              <span>Couldn't load AI proposals</span>
              <button
                type="button"
                onClick={() => void proposalsQ.refetch()}
                {...{ [KEEPS_POSITION]: '' }}
                className="flex-none font-semibold underline"
              >
                Retry
              </button>
            </div>
          )}
          {shownProposals.length > 0 && (
            <>
              <GroupLabel>AI proposals</GroupLabel>
              <div className="mx-3.5 mb-3.5 overflow-hidden rounded-2xl bg-surface">
                {shownProposals.map((line) => (
                  <ProposalRow
                    key={line.tx.id}
                    line={line}
                    selected={selected}
                    onToggle={toggleProposal}
                    onOpen={() => openTx(line.tx.id)}
                    onConfirmStaged={onConfirmStaged}
                    confirmBusy={confirmBusy}
                  />
                ))}
              </div>
              {(chosen.length > 0 || bookButton.pending) && (
                <div className="mx-3.5 mb-3.5">
                  <button
                    type="button"
                    disabled={booking}
                    onClick={onBook}
                    className="flex h-[46px] w-full items-center justify-between rounded-[13px] bg-accent-deep px-4 text-[13.5px] font-bold text-white disabled:opacity-60"
                  >
                    <span>
                      Book {bookButton.count} {bookButton.searched && 'shown '}
                      {bookButton.count === 1 ? 'match' : 'matches'}
                    </span>
                    <span className="text-[10.5px] font-medium opacity-70">
                      {bookButton.netCents > 0 ? '+' : ''}
                      {fmtCents(bookButton.netCents)} € net
                    </span>
                  </button>
                </div>
              )}
              {hiddenChosen > 0 && (
                <p className="mx-4 mb-3.5 text-[12px] text-ink-2">
                  {hiddenChosen} selected{' '}
                  {hiddenChosen === 1 ? 'match is' : 'matches are'} hidden by
                  the search and will not be booked.
                </p>
              )}
            </>
          )}
          {shownProposals.length === 0 && hiddenChosen > 0 && (
            <p className="mx-4 mb-3.5 text-[12px] text-ink-2">
              {hiddenChosen} selected{' '}
              {hiddenChosen === 1 ? 'match is' : 'matches are'} hidden by the
              search — clear it to book {hiddenChosen === 1 ? 'it' : 'them'}.
            </p>
          )}
          {shownDecide.length > 0 && (
            <>
              <GroupLabel>Decide yourself</GroupLabel>
              <div className="mx-3.5 mb-3.5 overflow-hidden rounded-2xl bg-surface">
                {shownDecide.map((line) => (
                  <DecideRow
                    key={line.tx.id}
                    line={line}
                    onOpen={() => openTx(line.tx.id)}
                  />
                ))}
              </div>
            </>
          )}
          {needle !== null && shownCount === 0 && (
            <EmptyState
              icon="⌕"
              title="No lines match"
              hint={`The search looks at ${STATEMENT_SEARCH.scope}.${
                seg === 'unmatched' && doneLines.length > 0
                  ? ' Matched lines are under All.'
                  : ''
              }`}
              action={
                <button
                  type="button"
                  disabled={op.pending}
                  onClick={clearSearch}
                  className="min-h-11 text-[14px] font-semibold text-accent"
                >
                  Clear search
                </button>
              }
            />
          )}
          {needle === null && unmatchedCount === 0 && (
            <EmptyState
              icon="✓"
              title="All lines reconciled"
              hint="Switch to All to review matched lines."
            />
          )}
          {shownDone.length > 0 && (
            <>
              <GroupLabel>Matched</GroupLabel>
              <div className="mx-3.5 mb-3.5 overflow-hidden rounded-2xl bg-surface">
                {shownDone.map((line) => (
                  <DoneRow
                    key={line.tx.id}
                    line={line}
                    onOpen={() => openTx(line.tx.id)}
                  />
                ))}
              </div>
            </>
          )}
        </>
      )}

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete statement?"
        body={`Deletes the statement and its ${lines.length} transactions. This cannot be undone.`}
        confirmLabel="Delete statement"
        destructive
        busy={deleting}
        onConfirm={onDelete}
      />
    </div>
  );
}
