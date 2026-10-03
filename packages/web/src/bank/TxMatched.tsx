import {
  fmtCents,
  type BankTransaction,
  type MatchRowView,
  type ReconciliationStatusRow,
} from '../api';
import { usePendingOperation, useSessionTask } from '../lib/pendingOperation';
import { confirmStagedMatch, undoMatches } from '../queries/bank';
import { ActionBar } from '../ui/ActionBar';
import { Button } from '../ui/Button';
import { Chip } from '../ui/Chip';
import {
  GroupLabel,
  KeyValue,
  ROW_BODY,
  ROW_IDENTITY,
  ROW_TRAILING,
} from '../ui/List';
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
  const op = usePendingOperation('Matched line');
  const sessionTask = useSessionTask();
  const busy = op.pending;
  const all = [...active, ...staged];

  const coverage =
    recon === undefined
      ? null
      : recon.remaining <= 0
        ? `full · ${fmtCents(recon.matchedSum)} of ${fmtCents(recon.amountBase)} €`
        : `partial · ${fmtCents(recon.matchedSum)} of ${fmtCents(recon.amountBase)} €`;

  const onUnmatch = () => {
    const ids = all.map((m) => m.id);
    op.run((ctx) => undoMatches(statementId, ids, ctx.check), {
      onSuccess: () => {
        toastOk('Match removed — the line is unmatched again');
        onChanged();
      },
      onError: (e) => {
        toastErr(e instanceof Error ? e.message : String(e));
        onChanged();
      },
    });
  };

  const onConfirm = () => {
    const ids = staged.map((m) => m.id);
    const amount = tx.amount;
    op.run(
      async (ctx) => {
        for (const id of ids) {
          ctx.check();
          await confirmStagedMatch(id, ctx.check);
        }
      },
      {
        onSuccess: () => {
          // Undo belongs to the session that confirmed.
          const undo = sessionTask();
          toastUndo(`Confirmed · ${fmtCents(Math.abs(amount))} €`, () =>
            undo((stage) => undoMatches(statementId, ids, stage), {
              onSuccess: onChanged,
              onError: (e) => {
                toastErr(e instanceof Error ? e.message : String(e));
                // A partial undo may have changed server state — refresh
                // anyway.
                onChanged();
              },
            }),
          );
          onChanged();
        },
        onError: (e) => {
          // Some confirmations may have landed: the refetch shows which
          // are still staged, and a retry confirms only those.
          toastErr(e instanceof Error ? e.message : String(e));
          onChanged();
        },
      },
    );
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
            <div className={ROW_BODY}>
              <div className={ROW_IDENTITY}>
                <div className="text-[14.5px] font-semibold">
                  {m.objectLabel}
                </div>
                <div className="text-[12.5px] text-ink-2">
                  {m.counterpartyName ?? '—'}{' '}
                  {m.status === 'draft' && <Chip tone="warn">staged</Chip>}
                </div>
              </div>
              <div
                className={`${ROW_TRAILING} text-[14px] font-bold tabular-nums`}
              >
                {fmtCents(m.amountMatched)} €
              </div>
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
      <ActionBar className="flex gap-2.5">
        {staged.length > 0 && (
          <Button className="h-[46px] flex-1" busy={busy} onClick={onConfirm}>
            Confirm match
          </Button>
        )}
        <Button
          variant="secondary"
          className="h-[46px] flex-1"
          busy={busy}
          onClick={onUnmatch}
        >
          Unmatch
        </Button>
      </ActionBar>
      <p className="px-6 pb-2 text-center text-[10.5px] leading-[1.4] text-ink-3">
        Unmatch returns the line to unmatched · the booked object is untouched
      </p>
    </>
  );
}
