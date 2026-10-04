import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { fmtCents, type BankTransaction } from '../api';
import type { PendingOperation } from '../lib/pendingOperation';
import { useResultLog, writeChain, type ChainSlot } from '../lib/resultLog';
import {
  BookingPartialError,
  createExpenseFromLine,
  invalidateStatement,
  newFromLineProgress,
  type CreateFromLineInput,
  type CreateFromLineResult,
  type FromLineProgress,
} from '../queries/bank';
import { txTitle } from './format';
import { fromLineRecord } from './lineResults';

/** The two bank-line Expense scenarios the module owns. */
export type BankExpenseKind = 'create' | 'bank-fee';

const ACTION_LABEL: Record<BankExpenseKind, string> = {
  create: 'Create & match',
  'bank-fee': 'Bank fee',
};

/** What a failed bank-line Expense attempt leaves for the screen to state. */
export interface BankExpenseErrorInfo {
  /** The original error from the failed stage. */
  error: unknown;
  /** The confirmed stages of the attempt, as a snapshot. */
  progress: FromLineProgress;
  /** True once the server returned an Expense id — its facts are now the
   *  server's, so later failures are operation errors, never field errors. */
  createConfirmed: boolean;
}

export interface BankExpenseArgs {
  /** Which scenario: the ordinary form or the bank-fee action. */
  kind: BankExpenseKind;
  /** Validated input; the screen owns field validation. */
  input: CreateFromLineInput;
  /** Success continuation (notification + navigation). */
  onSuccess: (result: CreateFromLineResult) => void;
  /** Failure continuation (field mapping / operation error / toast). */
  onError: (info: BankExpenseErrorInfo) => void;
}

/**
 * The bank-line Expense lifecycle shared by TxCreateExpense and TxScreen's
 * bank-fee action (ADR-0040): owns the confirmed progress, the finished
 * result, the durable receipt and the statement refresh, and resumes the
 * existing createExpenseFromLine chain at its first unconfirmed step. The
 * callers own their input, presentation and navigation. The progress and
 * finished state live in the calling component — the form's for the ordinary
 * flow, TxScreen's for the fee — never lifted into a shared owner.
 */
export function useBankExpense(opts: {
  statementId: number;
  tx: BankTransaction | undefined;
  op: PendingOperation;
}): {
  run: (args: BankExpenseArgs) => void;
  /** The last failed attempt's confirmed progress (the form locks on it). */
  landed: FromLineProgress | null;
} {
  const { statementId, tx, op } = opts;
  const qc = useQueryClient();
  const log = useResultLog();
  const progress = useRef<FromLineProgress>(newFromLineProgress());
  const finished = useRef<CreateFromLineResult | null>(null);
  const record = useRef<ChainSlot['current']>(null);
  const [landed, setLanded] = useState<FromLineProgress | null>(null);

  const run = (args: BankExpenseArgs) => {
    if (tx === undefined) return;
    const describe = (
      extra: Pick<
        Parameters<typeof fromLineRecord>[0],
        'result' | 'error' | 'matchStaged'
      >,
    ) =>
      fromLineRecord({
        action: ACTION_LABEL[args.kind],
        lineTitle: txTitle(tx),
        statementId,
        txId: tx.id,
        amount: `${fmtCents(tx.amount)} €`,
        progress: progress.current,
        ...extra,
      });
    const write = (
      rec: ReturnType<typeof fromLineRecord>,
      live?: () => boolean,
    ) => {
      if (rec === null) return;
      writeChain(record, log.record, rec, live);
    };
    op.run(
      async (ctx) => {
        const result = await createExpenseFromLine(
          args.input,
          progress.current,
          ctx.check,
          (_p, matchStaged) => write(describe({ matchStaged }), ctx.live),
        );
        finished.current = result;
        write(describe({ result }), ctx.live);
        ctx.check();
        await invalidateStatement(qc, statementId);
        return result;
      },
      {
        onSuccess: (result) => args.onSuccess(result),
        onError: (e) => {
          // A failed refresh AFTER the chain finished keeps its outcome:
          // the receipt is written from the finished result, not the error.
          write(describe({ result: finished.current ?? undefined, error: e }));
          const p = { ...progress.current };
          setLanded(p);
          const info: BankExpenseErrorInfo = {
            error: e,
            progress: p,
            createConfirmed: p.expenseId !== null,
          };
          args.onError(info);
          // Q10: the two scenarios keep their own error-path refresh. The
          // fee action refetches on every handled error; the ordinary form
          // only once an Expense id is known or the failure was the staged
          // match's partial approval.
          if (
            args.kind === 'bank-fee' ||
            p.expenseId !== null ||
            e instanceof BookingPartialError
          ) {
            void invalidateStatement(qc, statementId);
          }
        },
      },
    );
  };

  return { run, landed };
}
