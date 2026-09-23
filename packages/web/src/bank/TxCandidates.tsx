import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  fmtCents,
  type BankTransaction,
  type MatchCandidateView,
  type MatchCandidatesResult,
} from '../api';
import {
  BookingPartialError,
  bookManualMatch,
  invalidateStatement,
} from '../queries/bank';
import { ActionBar } from '../ui/ActionBar';
import { Button } from '../ui/Button';
import { GroupLabel, ROW_BODY, ROW_IDENTITY, ROW_TRAILING } from '../ui/List';
import { PendingFieldset } from '../ui/Form';
import { toastErr } from '../ui/toast';
import {
  errorMessage,
  rethrowIfEnded,
  type PendingOperation,
} from '../lib/pendingOperation';
import {
  useResultLog,
  slotHandle,
  writeChain,
  type ChainSlot,
  type ResultHandle,
  type ResultLink,
  type ResultTone,
} from '../lib/resultLog';
import { txTitle } from './format';
import { lineLinks, lineSubject } from './lineResults';
import { useUnsavedChanges } from '../lib/unsavedChanges';

/**
 * State C — the server found open candidates; N:M with a live remainder.
 * The remainder is display math only (the server enforces caps at
 * activation). A partial remainder STAYS OPEN on the line — the API's
 * prepayment endpoint books whole lines only, so remainder→prepayment is
 * deferred to server work (see plan appendix).
 */
export function TxCandidates({
  statementId,
  tx,
  result,
  preselectVoucherIds,
  op,
  onMatched,
}: {
  statementId: number;
  tx: BankTransaction;
  result: MatchCandidatesResult;
  preselectVoucherIds: number[];
  /** The LINE's operation, owned by TxScreen (stays mounted while the
   *  statement refresh re-routes the line — issue #251). */
  op: PendingOperation;
  /** `record`: the booking's durable result (#259), for Undo to update. */
  onMatched: (
    matchIds: number[],
    totalCents: number,
    record: ResultHandle | null,
  ) => void;
}) {
  const qc = useQueryClient();
  const log = useResultLog();
  const matchRecord = useRef<ChainSlot['current']>(null);
  const [selected, setSelected] = useState<Set<number>>(
    () =>
      new Set(
        preselectVoucherIds.filter((id) =>
          result.candidates.some((c) => c.voucherId === id),
        ),
      ),
  );
  const busy = op.pending;
  // Seeded once from the high-confidence proposals (frozen alike).
  const [baseline] = useState(selected);
  const guard = useUnsavedChanges({
    label: 'Match open items',
    values: selected,
    baseline,
  });

  // Allocation in candidate order: each selected candidate settles up to its
  // own outstanding, capped by what is left of the line.
  const allocations: { candidate: MatchCandidateView; amount: number }[] = [];
  let left = result.lineRemaining;
  for (const c of result.candidates) {
    if (!selected.has(c.voucherId) || left <= 0) continue;
    const amount = Math.min(c.voucherRemaining, left);
    allocations.push({ candidate: c, amount });
    left -= amount;
  }
  const allocated = result.lineRemaining - left;

  const toggle = (voucherId: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(voucherId)) next.delete(voucherId);
      else next.add(voucherId);
      return next;
    });

  const onBook = () => {
    if (allocated <= 0) return;
    const plan = allocations.map(({ candidate, amount }) => ({
      voucherId: candidate.voucherId,
      amount,
      matchType:
        amount === candidate.voucherRemaining &&
        amount === result.lineRemaining &&
        allocations.length === 1
          ? ('exact' as const)
          : ('partial' as const),
    }));
    const txId = tx.id;
    const objectLinks: ResultLink[] = allocations.flatMap(({ candidate: c }) =>
      c.objectId === null || c.objectType === 'prepayment'
        ? []
        : [
            {
              label: c.objectLabel,
              to:
                c.objectType === 'expense'
                  ? `/books/expenses/${c.objectId}`
                  : `/books/invoices/${c.objectId}`,
            },
          ],
    );
    const names = allocations.map((a) => a.candidate.objectLabel).join(', ');
    const [lineLink, statementLink] = lineLinks(statementId, txId);
    const sumOf = (n: number) =>
      `${fmtCents(plan.slice(0, n).reduce((sum, p) => sum + p.amount, 0))} €`;
    op.run(
      async (ctx) => {
        const matchIds: number[] = [];
        // The booking's durable record (#259): written after every match
        // the server accepted, before the next request.
        // One record per booking attempt series: a retry supersedes.
        const note = (tone: ResultTone, outcome: string) => {
          const init = {
            action: 'Match',
            title: `${txTitle(tx)} · ${fmtCents(tx.amount)} €`,
            subject: lineSubject(statementId, txId),
            links: [lineLink, ...objectLinks.slice(0, 2), statementLink],
            outcome,
            tone,
          };
          writeChain(matchRecord, log.record, init, ctx.live);
        };
        const stagedNote = (error: unknown) =>
          error instanceof BookingPartialError &&
          error.stagedMatchIds.length > error.approvedMatchIds.length
            ? ' A further match was staged; its approval was not confirmed — confirm it on the line if it is still staged.'
            : '';
        try {
          for (const p of plan) {
            ctx.check();
            matchIds.push(
              await bookManualMatch(
                statementId,
                {
                  bankTransactionId: txId,
                  voucherId: p.voucherId,
                  amountMatched: p.amount,
                  matchType: p.matchType,
                },
                ctx.check,
                {
                  staged: () =>
                    note(
                      'running',
                      `${matchIds.length > 0 ? `${matchIds.length} of ${plan.length} matches booked (${sumOf(matchIds.length)}); ` : ''}the match to ${allocations[matchIds.length]?.candidate.objectLabel ?? 'the item'} is staged — the approval's outcome is not known yet.`,
                    ),
                },
              ),
            );
            ctx.check();
            if (plan.length > 1 && matchIds.length < plan.length)
              note(
                'running',
                `${matchIds.length} of ${plan.length} matches booked (${sumOf(matchIds.length)}) — booking the rest…`,
              );
          }
        } catch (error) {
          rethrowIfEnded(error);
          if (matchIds.length === 0) {
            // Nothing booked — but the first match may be STAGED (its
            // approval failed): that is a partial outcome, not "nothing".
            if (stagedNote(error) !== '') {
              ctx.check();
              note(
                'partial',
                `The match to ${allocations[0]?.candidate.objectLabel ?? 'the item'} was staged; its approval was not confirmed (${errorMessage(error)}). Open the line — confirm the staged match there if it is still staged.`,
              );
            } else {
              ctx.check();
              note(
                'error',
                `Matching was not confirmed (${errorMessage(error)}). Open the line for its current state before matching again.`,
              );
            }
            throw error;
          }
          ctx.check();
          note(
            'partial',
            `${matchIds.length} of ${plan.length} matches booked (${sumOf(matchIds.length)}); the rest were not confirmed: ${errorMessage(error)}.${stagedNote(error)} Open the line for its current state.`,
          );
          // Partial success is real: report what actually landed.
          ctx.check();
          await invalidateStatement(qc, statementId);
          const landed = plan
            .slice(0, matchIds.length)
            .reduce((sum, p) => sum + p.amount, 0);
          return {
            matchIds,
            total: landed,
            error,
            record: slotHandle(matchRecord),
          };
        }
        ctx.check();
        note('ok', `Matched to ${names} · ${fmtCents(allocated)} €`);
        await invalidateStatement(qc, statementId);
        return {
          matchIds,
          total: allocated,
          error: null as unknown,
          record: slotHandle(matchRecord),
        };
      },
      {
        onSuccess: ({ matchIds, total, error, record }) => {
          if (error !== null) {
            toastErr(error instanceof Error ? error.message : String(error));
          }
          // What landed is on the server and onMatched leaves this line.
          guard.release();
          onMatched(matchIds, total, record);
        },
        onError: (e) => {
          toastErr(e instanceof Error ? e.message : String(e));
          // Nothing landed — or the FIRST match threw after staging
          // (BookingPartialError, zero activated): the line may be stranded
          // stale — refetch so it routes to matched-with-staged and a
          // Confirm primary (the recovery path already exists).
          void invalidateStatement(qc, statementId);
        },
      },
    );
  };

  const counterparty = result.candidates[0]?.counterpartyName;

  return (
    <PendingFieldset
      pending={busy}
      status="Matching… the line is locked until the server answers."
    >
      <GroupLabel>
        {counterparty ? `Open items · ${counterparty}` : 'Open items'}
      </GroupLabel>
      <div className="mx-3.5 mb-3 overflow-hidden rounded-2xl bg-surface">
        {result.candidates.map((c) => {
          const on = selected.has(c.voucherId);
          return (
            <button
              key={c.voucherId}
              type="button"
              role="checkbox"
              aria-checked={on}
              aria-label={c.objectLabel}
              onClick={() => toggle(c.voucherId)}
              className="flex w-full items-center gap-3 border-b border-line px-3.5 py-3 text-left last:border-b-0"
            >
              <span
                aria-hidden
                className={`flex h-[22px] w-[22px] flex-none items-center justify-center rounded-[7px] border-2 text-[13px] font-bold ${
                  on
                    ? 'border-accent bg-accent text-white'
                    : 'border-chevron text-transparent'
                }`}
              >
                ✓
              </span>
              {/* The full label is visible — same-prefix candidates differ
                  only in their tails (#275); a huge amount wraps below. */}
              <div className={ROW_BODY}>
                <div className={ROW_IDENTITY}>
                  <div className="text-[14.5px] font-semibold">
                    {c.objectLabel}
                  </div>
                  <div className="text-[12.5px] text-ink-2">
                    outstanding {fmtCents(c.voucherRemaining)} €
                  </div>
                </div>
                <div
                  className={`${ROW_TRAILING} text-[14px] font-bold tabular-nums ${on ? '' : 'text-ink-2'}`}
                >
                  {fmtCents(c.voucherRemaining)}
                </div>
              </div>
            </button>
          );
        })}
      </div>
      {allocated > 0 && left > 0 && (
        <div className="mx-3.5 mb-3 rounded-[13px] bg-warn-bg px-3.5 py-2.5 text-[12px] leading-[1.45] text-warn">
          <b className="mb-0.5 block text-[10.5px] uppercase tracking-wide">
            Line remainder · {fmtCents(left)} €
          </b>
          Stays open on this line — match more items now or later. (Recording a
          remainder as a prepayment needs server support; a matchless line can
          be recorded as a whole-line prepayment from the "Or" sheet.)
        </div>
      )}
      <ActionBar>
        <Button
          className="h-[46px] w-full"
          disabled={allocated <= 0}
          busy={busy}
          onClick={onBook}
        >
          Match {fmtCents(allocated)} €
        </Button>
      </ActionBar>
      <p className="px-6 pb-2 text-center text-[10.5px] leading-[1.4] text-ink-3">
        N:M — the remainder is never lost: it stays visible on the line
      </p>
    </PendingFieldset>
  );
}
