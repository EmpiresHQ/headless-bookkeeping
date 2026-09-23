import { useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { createPrepayment, fmtCents, markPersonal } from '../api';
import type { AdvanceTaxInput } from '../api';
import type { BankTransaction } from '../api';
import {
  createExpenseFromLine,
  invalidateStatement,
  newFromLineProgress,
  undoMatches,
  useAdvanceVatTreatments,
  useBankTransactions,
  useCategories,
  useMatchCandidates,
  useMatchProposals,
  useReconciliation,
  useStatementMatches,
  type CreateFromLineResult,
} from '../queries/bank';
import { usePendingOperation, useSessionTask } from '../lib/pendingOperation';
import { useSheet } from '../lib/useSheet';
import { AmountText } from '../ui/AmountText';
import { Chip } from '../ui/Chip';
import { SkeletonRows } from '../ui/Feedback';
import { toastErr, toastOk, toastUndo } from '../ui/toast';
import { ScreenHeader } from '../shell/Headers';
import { useCompletionNavigation } from '../lib/returnNavigation';
import { formatTxDate, txTitle } from './format';
import { LoadError } from './LoadError';
import { routeTxState } from './txState';
import { TxCandidates } from './TxCandidates';
import { TxCreateExpense } from './TxCreateExpense';
import {
  IncomingOpen,
  OrRow,
  OtherSheet,
  PersonalSheet,
  PrepaymentSheet,
} from './TxDispositions';
import { TxMatched } from './TxMatched';

/** Exhaustiveness guard for the `TxState` switch below — a compile error at
 *  the `default` case is the point: adding a TxState kind without handling
 *  it here must fail `tsc`, not silently render nothing. */
function assertNever(x: never): never {
  throw new Error(`Unreachable TxState: ${JSON.stringify(x)}`);
}

const DISPOSED_TITLE: Record<string, string> = {
  personal: 'Recorded as personal',
  prepayment: 'Recorded as prepayment',
  bank_fee: 'Recorded as bank fee',
  dividend: 'Recorded as dividend',
};

/** /bank/statements/:id/tx/:txId — the 90%-of-time screen. It reads the
 *  line's context and opens on the right action (routing matrix, Task 8). */
/** Keyed by the line it shows: /tx/1 → /tx/2 (Back/forward, after the
 *  unsaved-changes guard allowed it) remounts, so no inline form draft,
 *  open sheet or `createDone` flag of line 1 carries over to line 2. */
export function TxScreen() {
  const params = useParams();
  return (
    <TxScreenFor
      key={`${params.id}-${params.txId}`}
      statementId={Number(params.id)}
      txId={Number(params.txId)}
    />
  );
}

function TxScreenFor({
  statementId,
  txId,
}: {
  statementId: number;
  txId: number;
}) {
  const { returnTo } = useCompletionNavigation();
  const qc = useQueryClient();
  const [searchParams] = useSearchParams();
  // Carry the statement's segment filter (`?seg=all`) across the round trip
  // to this screen and back — dropping it silently resets the operator's
  // "All" view to "Unmatched" on every tap into a line.
  const seg = searchParams.get('seg');
  const statementPath = `/bank/statements/${statementId}${seg === 'all' ? '?seg=all' : ''}`;

  const txQ = useBankTransactions(statementId);
  const reconQ = useReconciliation(statementId);
  const matchesQ = useStatementMatches(statementId);
  const proposalsQ = useMatchProposals(statementId);
  const categoriesQ = useCategories();

  const tx = txQ.data?.find((t) => t.id === txId);
  // The treatments this jurisdiction allows for a receipt on THIS date — the
  // rate in force is part of the answer, so the date matters (issue #213).
  const vatTreatmentsQ = useAdvanceVatTreatments(
    tx && tx.amount > 0 ? tx.transaction_date : undefined,
  );
  const candQ = useMatchCandidates(
    statementId,
    txId,
    tx !== undefined && tx.status === 'open',
  );

  const state = routeTxState({
    tx,
    matches: matchesQ.data,
    candidates: candQ.data,
  });
  const recon = reconQ.data?.find((r) => r.bankTransactionId === txId);
  const unmatchedCount = useMemo(() => {
    const byTx = new Map(
      (reconQ.data ?? []).map((r) => [r.bankTransactionId, r.reconStatus]),
    );
    return (txQ.data ?? []).filter(
      (t) => t.status === 'open' && byTx.get(t.id) !== 'matched',
    ).length;
  }, [txQ.data, reconQ.data]);

  const [otherOpen, setOtherOpen] = useState(false);
  const [personalOpen, setPersonalOpen] = useState(false);
  const prepay = useSheet();
  const op = usePendingOperation('Bank line');
  const sessionTask = useSessionTask();
  const busy = op.pending;
  // Stages of the bank-fee chain the server already accepted (issue #251):
  // choosing "Bank fee" again resumes, never creates a second expense.
  const feeProgress = useRef(newFromLineProgress());
  // Belt to the line operation's own duplicate lock (issue #251 — held
  // until onCreateDone returns): once a create has succeeded, the create
  // form is gone for good on this line, whatever the refetch routes to
  // next, so its posted, undeletable expense can never be posted twice.
  const [createDone, setCreateDone] = useState(false);

  const preselect = useMemo(
    () =>
      (proposalsQ.data ?? [])
        .filter((p) => p.bankTransactionId === txId && p.confidence === 'high')
        .map((p) => p.voucherId),
    [proposalsQ.data, txId],
  );
  const feeCategory = (categoriesQ.data ?? []).find(
    (c) => c.key === 'bank fee',
  );

  // Every operation on this line — including the conditional children's
  // (TxCreateExpense, TxCandidates get `op`) — belongs to THIS component:
  // it stays mounted while the awaited statement refresh re-routes the
  // line and unmounts a child, so a genuine success is never dropped as
  // stale, and one line runs one operation at a time. The leave itself is
  // the synchronous continuation.
  // Issue #252: back to the statement entry this line was opened from (a
  // copy of it replaces the finished line), else the statement by replace.
  const leaveToStatement = () =>
    returnTo({
      fallback: statementPath,
      acceptOrigin: (p) => p === `/bank/statements/${statementId}`,
    });

  const onMatched = (matchIds: number[], totalCents: number) => {
    const total = fmtCents(totalCents);
    // Undo belongs to the session that booked the matches.
    const undo = sessionTask();
    leaveToStatement();
    toastUndo(`Matched · ${total} €`, () =>
      undo(
        (stage) =>
          undoMatches(statementId, matchIds, stage).then(() => {
            stage();
            return invalidateStatement(qc, statementId);
          }),
        {
          onSuccess: () => undefined,
          onError: (e) => {
            toastErr(e instanceof Error ? e.message : String(e));
            void invalidateStatement(qc, statementId);
          },
        },
      ),
    );
  };

  const onCreateDone = (r: CreateFromLineResult) => {
    setCreateDone(true);
    if (r.outcome === 'matched') {
      // The expense is POSTED — deleting it is not legal, so no Undo lie.
      toastOk(`Expense created & matched · ${fmtCents(tx?.amount ?? 0)} €`);
    } else {
      toastOk(
        `Expense created — held for approval: ${r.reason}. Match it after approval.`,
      );
    }
    leaveToStatement();
  };

  const onPersonal = () => {
    op.run(
      async (ctx) => {
        await markPersonal(txId);
        ctx.check();
        await invalidateStatement(qc, statementId);
      },
      {
        onSuccess: () => {
          toastOk('Recorded as personal');
          setPersonalOpen(false);
          leaveToStatement();
        },
        onError: (e) => {
          toastErr(e instanceof Error ? e.message : String(e));
          setPersonalOpen(false);
          void invalidateStatement(qc, statementId);
        },
      },
    );
  };

  const onPrepayment = (
    tax: AdvanceTaxInput | undefined,
    release: () => void,
  ) => {
    // Say what actually happened. Only money RECEIVED can be held: a
    // supplier advance declares no output VAT, so it is usable as it always
    // was (issue #213).
    const incoming = (tx?.amount ?? 0) > 0;
    const receipt = !incoming
      ? 'Recorded as prepayment'
      : tax === undefined || tax.tax_treatment === 'unresolved'
        ? 'Recorded — held until its tax treatment is set'
        : tax.tax_treatment === 'taxable_supply'
          ? 'Recorded as a taxable advance — VAT declared on the payment date'
          : 'Recorded as a deposit';
    op.run(
      async (ctx) => {
        await createPrepayment(txId, tax);
        ctx.check();
        await invalidateStatement(qc, statementId);
      },
      {
        onSuccess: () => {
          toastOk(receipt);
          release();
          prepay.close();
          leaveToStatement();
        },
        onError: (e) => {
          // Keep the sheet and what was typed: a failed record is retryable.
          toastErr(e instanceof Error ? e.message : String(e));
          void invalidateStatement(qc, statementId);
        },
      },
    );
  };

  const onFee = () => {
    if (!tx || !feeCategory) return;
    const input = {
      statementId,
      bankTransactionId: txId,
      category: feeCategory.key,
      grossCents: Math.abs(tx.amount),
      vatCents: 0, // financial services — no input VAT
      currency: tx.currency,
      taxPointDate: tx.transaction_date,
      supplierId: null,
    };
    const amount = tx.amount;
    op.run(
      async (ctx) => {
        const r = await createExpenseFromLine(
          input,
          feeProgress.current,
          ctx.check,
        );
        ctx.check();
        await invalidateStatement(qc, statementId);
        return r;
      },
      {
        onSuccess: (r) => {
          setOtherOpen(false);
          if (r.outcome === 'matched') {
            toastOk(`Bank fee recorded · ${fmtCents(amount)} €`);
          } else {
            toastOk(`Bank fee held for approval: ${r.reason}`);
          }
          leaveToStatement();
        },
        onError: (e) => {
          // The chain can land its first stages then fail: say what is
          // already on the books, and refetch so the line reflects it.
          const p = feeProgress.current;
          const message = e instanceof Error ? e.message : String(e);
          toastErr(
            p.expenseId === null
              ? message
              : p.stagedMatchIds !== null
                ? `Bank-fee expense #${p.expenseId} is posted and its match is staged but not approved (${message}) — confirm it on the statement.`
                : `Bank-fee expense #${p.expenseId} is already ${p.posted === null ? 'created' : 'posted'} (${message}) — choosing Bank fee again finishes it, without a second expense.`,
          );
          void invalidateStatement(qc, statementId);
        },
      },
    );
  };

  const title =
    state.kind === 'matched'
      ? 'Matched'
      : state.kind === 'disposed'
        ? (DISPOSED_TITLE[state.status] ?? state.status)
        : `${unmatchedCount} unmatched`;

  const showOr = state.kind === 'candidates' || state.kind === 'create';

  // An errored query skeletons forever if unhandled: the state machine
  // never advances past `loading` once its inputs are undefined-forever.
  // candQ only matters once the tx is known to be open (it's gated the
  // same way in the useMatchCandidates(enabled) call above).
  const failingQuery = txQ.isError
    ? txQ
    : matchesQ.isError
      ? matchesQ
      : tx?.status === 'open' && candQ.isError
        ? candQ
        : null;

  /** The state-dependent body — a switch over `TxState` so adding a kind
   *  without handling it here is a compile error, not a silent no-op. */
  const renderState = (tx: BankTransaction): ReactNode => {
    switch (state.kind) {
      case 'loading':
        return <SkeletonRows count={3} />;
      case 'disposed':
        return (
          <div className="mx-3.5 mb-3 rounded-2xl bg-surface px-3.5 py-3 text-center text-[13px] text-ink-2">
            This line is settled as a disposition. No further action is
            available here.
          </div>
        );
      case 'matched':
        return (
          <TxMatched
            statementId={statementId}
            tx={tx}
            active={state.active}
            staged={state.staged}
            recon={recon}
            onChanged={() => void invalidateStatement(qc, statementId)}
          />
        );
      case 'candidates':
        return (
          <TxCandidates
            statementId={statementId}
            tx={tx}
            result={state.result}
            preselectVoucherIds={preselect}
            op={op}
            onMatched={onMatched}
          />
        );
      case 'create':
        return createDone ? (
          <SkeletonRows count={2} />
        ) : (
          <TxCreateExpense
            statementId={statementId}
            tx={tx}
            op={op}
            onDone={onCreateDone}
          />
        );
      case 'incoming-open':
        return <IncomingOpen tx={tx} onPrepayment={() => prepay.open()} />;
      default:
        return assertNever(state);
    }
  };

  return (
    <div className="mx-auto max-w-3xl pb-6">
      <ScreenHeader title={title} backTo={statementPath} />
      {failingQuery ? (
        <LoadError
          message={
            failingQuery.error instanceof Error
              ? failingQuery.error.message
              : 'Failed to load this line'
          }
          onRetry={() => void failingQuery.refetch()}
        />
      ) : tx === undefined ? (
        txQ.isSuccess ? (
          <div className="mx-3.5 mb-3 rounded-2xl bg-surface px-3.5 py-3 text-center text-[13px] text-ink-2">
            Line not found
            <div className="mt-2">
              <Link to={statementPath} className="font-semibold text-accent">
                Back to statement
              </Link>
            </div>
          </div>
        ) : (
          <SkeletonRows count={3} />
        )
      ) : (
        <>
          <div className="px-5 pb-3 pt-1.5 text-center">
            {/* The amount is a fact from the bank — not tappable, not a field. */}
            <AmountText
              cents={tx.amount}
              currency={tx.currency}
              showSign
              className="block text-[30px] font-extrabold leading-[1.15] tracking-tight"
            />
            <p className="truncate text-[12.5px] text-ink-2">
              {txTitle(tx)} · {formatTxDate(tx.transaction_date)}
            </p>
            {state.kind === 'matched' && (
              <div className="mt-1.5">
                <Chip tone="ok">matched ✓</Chip>
              </div>
            )}
          </div>

          {renderState(tx)}

          {showOr && !createDone && (
            <OrRow onClick={() => setOtherOpen(true)} />
          )}

          <OtherSheet
            open={otherOpen}
            onOpenChange={setOtherOpen}
            tx={tx}
            hasMatches={state.kind === 'matched'}
            feeAvailable={feeCategory !== undefined}
            busy={busy}
            onPersonal={() => {
              setOtherOpen(false);
              setPersonalOpen(true);
            }}
            onFee={onFee}
            onPrepayment={() => {
              setOtherOpen(false);
              prepay.open();
            }}
          />
          <PersonalSheet
            open={personalOpen}
            onOpenChange={setPersonalOpen}
            tx={tx}
            busy={busy}
            onConfirm={onPersonal}
          />
          {prepay.epoch > 0 && (
            <PrepaymentSheet
              key={prepay.epoch}
              open={prepay.isOpen}
              onOpenChange={(o) => !o && prepay.close()}
              tx={tx}
              busy={busy}
              vatTreatments={vatTreatmentsQ.data ?? []}
              onConfirm={onPrepayment}
            />
          )}
        </>
      )}
    </div>
  );
}
