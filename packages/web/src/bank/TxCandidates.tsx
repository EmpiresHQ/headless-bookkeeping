import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  fmtCents,
  type BankTransaction,
  type MatchCandidateView,
  type MatchCandidatesResult,
} from '../api';
import { bookManualMatch, invalidateStatement } from '../queries/bank';
import { Button } from '../ui/Button';
import { GroupLabel } from '../ui/List';
import { toastErr } from '../ui/toast';

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
  onMatched,
}: {
  statementId: number;
  tx: BankTransaction;
  result: MatchCandidatesResult;
  preselectVoucherIds: number[];
  onMatched: (matchIds: number[], totalCents: number) => void;
}) {
  const qc = useQueryClient();
  const [selected, setSelected] = useState<Set<number>>(
    () =>
      new Set(
        preselectVoucherIds.filter((id) =>
          result.candidates.some((c) => c.voucherId === id),
        ),
      ),
  );
  const [busy, setBusy] = useState(false);

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

  const onBook = async () => {
    setBusy(true);
    const matchIds: number[] = [];
    try {
      for (const { candidate, amount } of allocations) {
        const matchType =
          amount === candidate.voucherRemaining &&
          amount === result.lineRemaining &&
          allocations.length === 1
            ? 'exact'
            : 'partial';
        matchIds.push(
          await bookManualMatch(statementId, {
            bankTransactionId: tx.id,
            voucherId: candidate.voucherId,
            amountMatched: amount,
            matchType,
          }),
        );
      }
      onMatched(matchIds, allocated);
    } catch (e) {
      toastErr(e instanceof Error ? e.message : String(e));
      // Partial success is real: report what actually landed.
      if (matchIds.length > 0) {
        const landed = allocations
          .slice(0, matchIds.length)
          .reduce((sum, a) => sum + a.amount, 0);
        onMatched(matchIds, landed);
      } else {
        // The FIRST match threw after staging (BookingPartialError, zero
        // landed): nothing to report via onMatched, but the line is now
        // stranded stale — refetch so it routes to matched-with-staged and
        // a Confirm primary (the recovery path already exists).
        void invalidateStatement(qc, statementId);
      }
    } finally {
      setBusy(false);
    }
  };

  const counterparty = result.candidates[0]?.counterpartyName;

  return (
    <>
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
                    : 'border-[#C2C7C1] text-transparent'
                }`}
              >
                ✓
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[14.5px] font-semibold">
                  {c.objectLabel}
                </div>
                <div className="truncate text-[12.5px] text-ink-2">
                  outstanding {fmtCents(c.voucherRemaining)} €
                </div>
              </div>
              <div
                className={`flex-none text-[14px] font-bold tabular-nums ${on ? '' : 'text-ink-2'}`}
              >
                {fmtCents(c.voucherRemaining)}
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
      <div className="sticky bottom-0 bg-gradient-to-t from-bg via-bg/95 to-transparent px-4 pb-3.5 pt-3">
        <Button
          className="h-[46px] w-full"
          disabled={allocated <= 0}
          busy={busy}
          onClick={() => void onBook()}
        >
          Match {fmtCents(allocated)} €
        </Button>
      </div>
      <p className="px-6 pb-2 text-center text-[10.5px] leading-[1.4] text-[#8A9089]">
        N:M — the remainder is never lost: it stays visible on the line
      </p>
    </>
  );
}
