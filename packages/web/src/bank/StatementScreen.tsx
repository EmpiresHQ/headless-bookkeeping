import { useEffect, useMemo, useRef, useState } from 'react';
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
import { AmountText } from '../ui/AmountText';
import { Button } from '../ui/Button';
import { Chip } from '../ui/Chip';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { EmptyState, SkeletonRows } from '../ui/Feedback';
import { GroupLabel } from '../ui/List';
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

/** Line amount + date, right-aligned, never wrapping. */
function LineTrailing({ line, muted }: { line: LineView; muted?: boolean }) {
  return (
    <div className="flex-none text-right">
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
      className="flex w-full items-center gap-3 border-b border-line px-3.5 py-3 text-left last:border-b-0"
    >
      <div className="min-w-0 flex-1">
        <div className="truncate text-[14.5px] font-semibold">
          {txTitle(line.tx)}
        </div>
        <div className="truncate text-[12.5px] text-ink-2">
          {partial
            ? `Partially matched · ${fmtCents(line.recon?.remaining ?? 0)} € left`
            : 'No AI match — decide'}
        </div>
      </div>
      <LineTrailing line={line} />
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
              className="flex min-h-11 min-w-0 flex-1 items-center gap-3 text-left"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-[14.5px] font-semibold">
                  {txTitle(line.tx)}
                </div>
                <div className="truncate text-[12.5px] text-ink-2">
                  → {p.objectLabel} <Chip tone="warn">{p.confidence}</Chip>
                </div>
              </div>
              <LineTrailing line={line} />
            </button>
          </div>
        );
      })}
      {line.staged.map((m) => (
        <div key={m.id} className="flex w-full items-center gap-3 px-3.5 py-3">
          <button
            type="button"
            onClick={onOpen}
            className="flex min-h-11 min-w-0 flex-1 items-center gap-3 text-left"
          >
            <div className="min-w-0 flex-1">
              <div className="truncate text-[14.5px] font-semibold">
                {txTitle(line.tx)}
              </div>
              <div className="truncate text-[12.5px] text-ink-2">
                → {m.objectLabel} <Chip tone="warn">staged</Chip>
              </div>
            </div>
            <LineTrailing line={line} />
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
      <div className="min-w-0 flex-1">
        <div className="truncate text-[14.5px] font-semibold text-ink-2">
          {txTitle(line.tx)}
        </div>
        {disposed ? (
          <div className="mt-0.5">
            <Chip>{DISPOSITION_LABEL[line.tx.status] ?? line.tx.status}</Chip>
          </div>
        ) : (
          <div className="truncate text-[12.5px] text-ink-2">
            → {line.active.map((m) => m.objectLabel).join(' · ')}
          </div>
        )}
      </div>
      <LineTrailing line={line} muted />
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

  const toggleProposal = (p: MatchProposalView) =>
    setSelected((prev) => {
      const next = new Set(prev);
      const key = proposalKey(p);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const chosen = (proposalsQ.data ?? []).filter((p) =>
    selected.has(proposalKey(p)),
  );
  const txById = new Map(lines.map((l) => [l.tx.id, l.tx]));
  const netCents = chosen.reduce((sum, p) => {
    const tx = txById.get(p.bankTransactionId);
    return sum + (tx && tx.amount < 0 ? -p.amountMatched : p.amountMatched);
  }, 0);

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
          const record = slotHandle(bookRecord);
          // A new booking is a new record.
          bookRecord.current = null;
          offerUndo(`Booked ${plural(matchIds.length)}`, matchIds, record);
        },
        onError: (e) => {
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
    if (started) setRunning('book');
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

  const proposalLines = lines.filter((l) => bucketOf(l) === 'proposals');
  const decideLines = lines.filter((l) => bucketOf(l) === 'decide');
  const doneLines = lines.filter((l) => bucketOf(l) === 'done');
  const unmatchedCount = proposalLines.length + decideLines.length;

  const openTx = (txId: number) =>
    navigate(
      `/bank/statements/${statementId}/tx/${txId}${seg === 'all' ? '?seg=all' : ''}`,
      { state: origin },
    );

  return (
    <div className="mx-auto max-w-3xl pb-28">
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
      <div className="px-4 pb-3">
        <SegmentedControl
          options={[
            { value: 'unmatched', label: `Unmatched ${unmatchedCount}` },
            { value: 'all', label: `All ${lines.length}` },
          ]}
          value={seg}
          onChange={(v) =>
            // In place: keep this entry's own origin record (issue #252).
            setSearchParams(v === 'all' ? { seg: 'all' } : {}, {
              replace: true,
              state: location.state as unknown,
            })
          }
        />
      </div>

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
                className="flex-none font-semibold underline"
              >
                Retry
              </button>
            </div>
          )}
          {proposalLines.length > 0 && (
            <>
              <GroupLabel>AI proposals</GroupLabel>
              <div className="mx-3.5 mb-3.5 overflow-hidden rounded-2xl bg-surface">
                {proposalLines.map((line) => (
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
              {chosen.length > 0 && (
                <div className="mx-3.5 mb-3.5">
                  <button
                    type="button"
                    disabled={booking}
                    onClick={onBook}
                    className="flex h-[46px] w-full items-center justify-between rounded-[13px] bg-accent-deep px-4 text-[13.5px] font-bold text-white disabled:opacity-60"
                  >
                    <span>
                      Book {chosen.length}{' '}
                      {chosen.length === 1 ? 'match' : 'matches'}
                    </span>
                    <span className="text-[10.5px] font-medium opacity-70">
                      {netCents > 0 ? '+' : ''}
                      {fmtCents(netCents)} € net
                    </span>
                  </button>
                </div>
              )}
            </>
          )}
          {decideLines.length > 0 && (
            <>
              <GroupLabel>Decide yourself</GroupLabel>
              <div className="mx-3.5 mb-3.5 overflow-hidden rounded-2xl bg-surface">
                {decideLines.map((line) => (
                  <DecideRow
                    key={line.tx.id}
                    line={line}
                    onOpen={() => openTx(line.tx.id)}
                  />
                ))}
              </div>
            </>
          )}
          {unmatchedCount === 0 && (
            <EmptyState
              icon="✓"
              title="All lines reconciled"
              hint="Switch to All to review matched lines."
            />
          )}
          {seg === 'all' && doneLines.length > 0 && (
            <>
              <GroupLabel>Matched</GroupLabel>
              <div className="mx-3.5 mb-3.5 overflow-hidden rounded-2xl bg-surface">
                {doneLines.map((line) => (
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
