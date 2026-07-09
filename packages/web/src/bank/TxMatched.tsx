import { useState } from 'react';
import {
  fmtCents,
  type BankTransaction,
  type MatchRowView,
  type ReconciliationStatusRow,
} from '../api';
import { confirmStagedMatch, undoMatches } from '../queries/bank';
import { Button } from '../ui/Button';
import { Chip } from '../ui/Chip';
import { GroupLabel, KeyValue } from '../ui/List';
import { toastErr, toastOk, toastUndo } from '../ui/toast';

/**
 * State G — the line is matched (or staged by the import's auto-proposer).
 * Facts card: what it is matched with + coverage. Unmatch is a visible
 * secondary action (ledger-neutral server-side); staged drafts get a
 * Confirm primary. Match provenance (when/by whom) is not exposed by the
 * API — deliberately omitted rather than invented.
 */
export function TxMatched({
  statementId,
  tx,
  active,
  staged,
  recon,
  onChanged,
}: {
  statementId: number;
  tx: BankTransaction;
  active: MatchRowView[];
  staged: MatchRowView[];
  recon: ReconciliationStatusRow | undefined;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const all = [...active, ...staged];

  const coverage =
    recon === undefined
      ? null
      : recon.remaining <= 0
        ? `full · ${fmtCents(recon.matchedSum)} of ${fmtCents(recon.amountBase)} €`
        : `partial · ${fmtCents(recon.matchedSum)} of ${fmtCents(recon.amountBase)} €`;

  const onUnmatch = async () => {
    setBusy(true);
    try {
      await undoMatches(
        statementId,
        all.map((m) => m.id),
      );
      toastOk('Match removed — the line is unmatched again');
      onChanged();
    } catch (e) {
      toastErr(e instanceof Error ? e.message : String(e));
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const onConfirm = async () => {
    setBusy(true);
    try {
      for (const m of staged) {
        await confirmStagedMatch(m.id);
      }
      toastUndo(`Confirmed · ${fmtCents(Math.abs(tx.amount))} €`, () => {
        void undoMatches(
          statementId,
          staged.map((m) => m.id),
        )
          .then(onChanged)
          .catch((e) => toastErr(e instanceof Error ? e.message : String(e)));
      });
      onChanged();
    } catch (e) {
      toastErr(e instanceof Error ? e.message : String(e));
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <GroupLabel>Matched with</GroupLabel>
      <div className="mx-3.5 mb-3 overflow-hidden rounded-2xl bg-surface">
        {all.map((m) => (
          <div
            key={m.id}
            className="flex items-center gap-3 border-b border-line px-3.5 py-3 last:border-b-0"
          >
            <span
              aria-hidden
              className="flex h-[34px] w-[34px] flex-none items-center justify-center rounded-[10px] bg-ok-bg text-[15px]"
            >
              🧾
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[14.5px] font-semibold">
                {m.objectLabel}
              </div>
              <div className="truncate text-[12.5px] text-ink-2">
                {m.counterpartyName ?? '—'}{' '}
                {m.status === 'draft' && <Chip tone="warn">staged</Chip>}
              </div>
            </div>
            <div className="flex-none text-right text-[14px] font-bold tabular-nums">
              {fmtCents(m.amountMatched)} €
            </div>
          </div>
        ))}
      </div>
      {coverage != null && (
        <>
          <GroupLabel>Match details</GroupLabel>
          <div className="mx-3.5 mb-3 overflow-hidden rounded-2xl bg-surface">
            <KeyValue k="Coverage" v={coverage} />
          </div>
        </>
      )}
      <div className="sticky bottom-0 flex gap-2.5 bg-gradient-to-t from-bg via-bg/95 to-transparent px-4 pb-3.5 pt-3">
        {staged.length > 0 && (
          <Button
            className="h-[46px] flex-1"
            busy={busy}
            onClick={() => void onConfirm()}
          >
            Confirm match
          </Button>
        )}
        <Button
          variant="secondary"
          className="h-[46px] flex-1"
          busy={busy}
          onClick={() => void onUnmatch()}
        >
          Unmatch
        </Button>
      </div>
      <p className="px-6 pb-2 text-center text-[10.5px] leading-[1.4] text-[#8A9089]">
        Unmatch returns the line to unmatched · the booked object is untouched
      </p>
    </>
  );
}
