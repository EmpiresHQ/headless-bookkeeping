import { useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { deleteBankStatement, fmtCents } from '../api';
import {
  bankKeys,
  useBankStatements,
  useBankTransactions,
  useMatchProposals,
  useReconciliation,
  useStatementMatches,
} from '../queries/bank';
import { AmountText } from '../ui/AmountText';
import { Chip } from '../ui/Chip';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { EmptyState, SkeletonRows } from '../ui/Feedback';
import { GroupLabel } from '../ui/List';
import { SegmentedControl } from '../ui/SegmentedControl';
import { toastErr } from '../ui/toast';
import { ScreenHeader } from '../shell/Headers';
import { formatStatementPeriod, formatTxDate, txTitle } from './format';
import { LoadError } from './LoadError';
import { bucketOf, buildLines, type LineView } from './statementModel';

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
            : 'No candidates — decide'}
        </div>
      </div>
      <LineTrailing line={line} />
      <span aria-hidden className="flex-none text-base text-[#C2C7C1]">
        ›
      </span>
    </button>
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
          : 'bg-[#F5FAF6] shadow-[inset_3px_0_0_theme(colors.ok.DEFAULT)]'
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
  const [searchParams, setSearchParams] = useSearchParams();
  const seg = searchParams.get('seg') === 'all' ? 'all' : 'unmatched';

  const statementsQ = useBankStatements();
  const txQ = useBankTransactions(statementId);
  const reconQ = useReconciliation(statementId);
  const matchesQ = useStatementMatches(statementId);
  const proposalsQ = useMatchProposals(statementId);

  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

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

  const proposalLines = lines.filter((l) => bucketOf(l) === 'proposals');
  const decideLines = lines.filter((l) => bucketOf(l) === 'decide');
  const doneLines = lines.filter((l) => bucketOf(l) === 'done');
  const unmatchedCount = proposalLines.length + decideLines.length;

  const openTx = (txId: number) =>
    navigate(`/bank/statements/${statementId}/tx/${txId}`);

  const onDelete = async () => {
    setDeleting(true);
    try {
      await deleteBankStatement(statementId);
      await qc.invalidateQueries({ queryKey: bankKeys.statements });
      navigate('/bank');
    } catch (e) {
      toastErr(e instanceof Error ? e.message : String(e));
      setDeleting(false);
      setDeleteOpen(false);
    }
  };

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
            setSearchParams(v === 'all' ? { seg: 'all' } : {}, {
              replace: true,
            })
          }
        />
      </div>

      {loading && <SkeletonRows count={5} />}
      {txQ.isError && (
        <LoadError
          message={
            txQ.error instanceof Error
              ? txQ.error.message
              : 'Failed to load transactions'
          }
          onRetry={() => void txQ.refetch()}
        />
      )}

      {!loading && !txQ.isError && (
        <>
          {proposalLines.length > 0 && (
            <>
              <GroupLabel>AI proposals</GroupLabel>
              <div className="mx-3.5 mb-3.5 overflow-hidden rounded-2xl bg-surface">
                {proposalLines.map((line) => (
                  // Task 7 replaces this row with the selectable ProposalRow.
                  <DecideRow
                    key={line.tx.id}
                    line={line}
                    onOpen={() => openTx(line.tx.id)}
                  />
                ))}
              </div>
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
        onConfirm={() => void onDelete()}
      />
    </div>
  );
}
