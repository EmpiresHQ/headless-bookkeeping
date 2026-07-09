import { useMemo, useState, type ReactNode } from 'react';
import {
  Link,
  useNavigate,
  useParams,
  useSearchParams,
} from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { createPrepayment, fmtCents, markPersonal } from '../api';
import type { BankTransaction } from '../api';
import {
  createExpenseFromLine,
  invalidateStatement,
  undoMatches,
  useBankTransactions,
  useCategories,
  useMatchCandidates,
  useMatchProposals,
  useReconciliation,
  useStatementMatches,
  type CreateFromLineResult,
} from '../queries/bank';
import { AmountText } from '../ui/AmountText';
import { Chip } from '../ui/Chip';
import { SkeletonRows } from '../ui/Feedback';
import { toastErr, toastOk, toastUndo } from '../ui/toast';
import { ScreenHeader } from '../shell/Headers';
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
export function TxScreen() {
  const params = useParams();
  const statementId = Number(params.id);
  const txId = Number(params.txId);
  const navigate = useNavigate();
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
  const [prepayOpen, setPrepayOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  // Carry-over guard from Task 10's review: TxCreateExpense re-enables its
  // own primary in a `finally` right after calling onDone, and navigating
  // away from onDone is async (invalidate, then navigate). Without this
  // flag, TxCreateExpense would stay mounted with busy=false for one tick
  // after a successful create — a second click would post a duplicate,
  // undeletable expense. Setting `createDone` synchronously, first thing in
  // onCreateDone, unmounts TxCreateExpense in the SAME batched re-render as
  // its own setBusy(false) (React 18 batches updates across the microtask
  // continuation of the same async handler), closing the window.
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

  const backToStatement = async () => {
    await invalidateStatement(qc, statementId);
    navigate(statementPath);
  };

  const onMatched = (matchIds: number[], totalCents: number) => {
    const total = fmtCents(totalCents);
    void backToStatement().then(() => {
      toastUndo(`Matched · ${total} €`, () => {
        void undoMatches(statementId, matchIds)
          .then(() => invalidateStatement(qc, statementId))
          .catch((e) => {
            toastErr(e instanceof Error ? e.message : String(e));
            void invalidateStatement(qc, statementId);
          });
      });
    });
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
    void backToStatement();
  };

  const onPersonal = async () => {
    setBusy(true);
    try {
      await markPersonal(txId);
      toastOk('Recorded as personal');
      await backToStatement();
    } catch (e) {
      toastErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setPersonalOpen(false);
    }
  };

  const onPrepayment = async () => {
    setBusy(true);
    try {
      await createPrepayment(txId);
      toastOk('Recorded as prepayment');
      await backToStatement();
    } catch (e) {
      toastErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setPrepayOpen(false);
    }
  };

  const onFee = async () => {
    if (!tx || !feeCategory) return;
    setBusy(true);
    try {
      const r = await createExpenseFromLine({
        statementId,
        bankTransactionId: txId,
        category: feeCategory.key,
        grossCents: Math.abs(tx.amount),
        vatCents: 0, // financial services — no input VAT
        currency: tx.currency,
        taxPointDate: tx.transaction_date,
        supplierId: null,
      });
      setOtherOpen(false);
      if (r.outcome === 'matched') {
        toastOk(`Bank fee recorded · ${fmtCents(tx.amount)} €`);
      } else {
        toastOk(`Bank fee held for approval: ${r.reason}`);
      }
      await backToStatement();
    } catch (e) {
      // createExpenseFromLine can post the expense then fail at match —
      // invalidate so the line reflects the posted expense on refetch.
      toastErr(e instanceof Error ? e.message : String(e));
      await invalidateStatement(qc, statementId);
    } finally {
      setBusy(false);
    }
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
            onDone={onCreateDone}
          />
        );
      case 'incoming-open':
        return (
          <IncomingOpen tx={tx} onPrepayment={() => setPrepayOpen(true)} />
        );
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
              <Link
                to={statementPath}
                viewTransition
                className="font-semibold text-accent"
              >
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
            onFee={() => void onFee()}
            onPrepayment={() => {
              setOtherOpen(false);
              setPrepayOpen(true);
            }}
          />
          <PersonalSheet
            open={personalOpen}
            onOpenChange={setPersonalOpen}
            tx={tx}
            busy={busy}
            onConfirm={() => void onPersonal()}
          />
          <PrepaymentSheet
            open={prepayOpen}
            onOpenChange={setPrepayOpen}
            tx={tx}
            busy={busy}
            onConfirm={() => void onPrepayment()}
          />
        </>
      )}
    </div>
  );
}
