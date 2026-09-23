import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { fmtCents, type BankTransaction, type Entity } from '../api';
import {
  BookingPartialError,
  createExpenseFromLine,
  invalidateStatement,
  newFromLineProgress,
  useCategories,
  type CreateFromLineResult,
  type FromLineProgress,
} from '../queries/bank';
import { centsToEuroInput, eurosToCents, vatFromGross } from '../lib/money';
import type { PendingOperation } from '../lib/pendingOperation';
import { useResultLog, writeChain, type ChainSlot } from '../lib/resultLog';
import { useUnsavedChanges } from '../lib/unsavedChanges';
import { useSheet } from '../lib/useSheet';
import { ActionBar } from '../ui/ActionBar';
import { Button } from '../ui/Button';
import { Field, PendingFieldset, SelectInput, TextInput } from '../ui/Form';
import { GroupLabel, KeyValue } from '../ui/List';
import { toastErr } from '../ui/toast';
import { STANDARD_VAT_RATE_PCT, txTitle } from './format';
import { fromLineRecord } from './lineResults';
import { SupplierSheet } from './SupplierSheet';

function fmtDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}

/**
 * States A/B — the core inversion: the expense is created FROM the line.
 * Everything the line knows is a prefilled fact (amount, date); VAT is
 * prefigured at the standard rate (editable — no rate endpoint exists);
 * document policy: "receipt later" keeps VAT, "no receipt" → the line is the
 * source record and VAT is 0 (non-deductible without an invoice — the form
 * knows this rule, §6★).
 */
export function TxCreateExpense({
  statementId,
  tx,
  op,
  onDone,
}: {
  statementId: number;
  tx: BankTransaction;
  /** The LINE's operation, owned by TxScreen: it stays mounted while the
   *  statement refresh re-routes the line (and unmounts this form), so the
   *  success continuation is not dropped as stale (issue #251). */
  op: PendingOperation;
  onDone: (r: CreateFromLineResult) => void;
}) {
  const absCents = Math.abs(tx.amount);
  const categoriesQ = useCategories();
  const [category, setCategory] = useState('');
  const [supplier, setSupplier] = useState<Entity | null>(null);
  const picker = useSheet();
  const [docPolicy, setDocPolicy] = useState<'later' | 'none'>('later');
  const [vatInput, setVatInput] = useState(() =>
    centsToEuroInput(vatFromGross(absCents, STANDARD_VAT_RATE_PCT)),
  );
  const qc = useQueryClient();
  const busy = op.pending;
  // What the server already accepted (issue #251): a retry resumes after
  // it, never creates or posts a second expense. Rendered from `landed`, a
  // snapshot taken when an attempt fails.
  const progress = useRef<FromLineProgress>(newFromLineProgress());
  const [landed, setLanded] = useState<FromLineProgress | null>(null);
  // The chain's durable record (#259): created with its first accepted
  // stage, superseded by every later stage and by a retry's outcome.
  const log = useResultLog();
  const record = useRef<ChainSlot['current']>(null);
  const finished = useRef<CreateFromLineResult | null>(null);
  // Once the expense exists its facts are the server's: the form locks,
  // and there is no unsaved input left to lose.
  const locked = landed !== null && landed.expenseId !== null;
  // VAT is seeded from the line amount once (frozen with the rest).
  const values = { category, supplier, docPolicy, vatInput };
  const [baseline] = useState(values);
  const guard = useUnsavedChanges({
    label: 'Expense from bank line',
    values,
    baseline,
    active: !locked,
  });

  const vatCents = docPolicy === 'none' ? 0 : eurosToCents(vatInput);
  const valid =
    category !== '' &&
    vatCents !== null &&
    vatCents >= 0 &&
    vatCents <= absCents;

  const onSubmit = () => {
    if (vatCents === null) return;
    const input = {
      statementId,
      bankTransactionId: tx.id,
      category,
      grossCents: absCents,
      vatCents,
      currency: tx.currency,
      taxPointDate: tx.transaction_date,
      supplierId: supplier?.id ?? null,
    };
    const describe = (
      extra: Pick<
        Parameters<typeof fromLineRecord>[0],
        'result' | 'error' | 'matchStaged'
      >,
    ) =>
      fromLineRecord({
        action: 'Create & match',
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
          input,
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
        onSuccess: (result) => {
          guard.release();
          onDone(result);
        },
        onError: (e) => {
          // A failed refresh AFTER the chain finished keeps its outcome.
          write(describe({ result: finished.current ?? undefined, error: e }));
          const p = { ...progress.current };
          setLanded(p);
          toastErr(e instanceof Error ? e.message : String(e));
          // A staged-but-unapproved match (or any landed stage) changes
          // the line: refetch — a staged match routes the line to its
          // Confirm recovery.
          if (p.expenseId !== null || e instanceof BookingPartialError) {
            void invalidateStatement(qc, statementId);
          }
        },
      },
    );
  };

  return (
    <PendingFieldset
      pending={busy}
      status="Creating and matching… the form is locked until the server answers."
    >
      {landed !== null && landed.expenseId !== null && (
        <div
          role="status"
          className="mx-3.5 mb-3 rounded-[13px] bg-warn-bg px-3.5 py-2.5 text-[12px] leading-[1.45] text-warn"
        >
          <b className="mb-0.5 block text-[10.5px] uppercase tracking-wide">
            Already on the books
          </b>
          <Link
            className="font-semibold underline"
            to={`/books/expenses/${landed.expenseId}`}
          >
            Expense #{landed.expenseId}
          </Link>{' '}
          {landed.posted === null
            ? 'was created as a draft but not posted.'
            : 'was created and posted.'}{' '}
          {landed.stagedMatchIds !== null
            ? 'Its match is staged but not approved — confirm it on the statement.'
            : 'Retrying finishes the remaining steps for THAT expense — the fields below are its facts and can no longer be changed here.'}
        </div>
      )}
      <fieldset disabled={locked} className="m-0 min-w-0 border-0 p-0">
        <GroupLabel>Create expense from line</GroupLabel>
        <div className="mx-3.5 mb-3 overflow-hidden rounded-2xl bg-surface">
          <button
            type="button"
            onClick={() => picker.open()}
            className="flex w-full items-center justify-between gap-3 border-b border-line px-3.5 py-2.5 text-left"
          >
            <span className="text-[13px] text-ink-2">Supplier</span>
            <span className="min-w-0 truncate text-[13px] font-semibold">
              {supplier ? supplier.name : 'Choose or create ›'}
            </span>
          </button>
          <div className="border-b border-line px-3.5 py-2.5">
            <Field label="Category">
              <SelectInput
                value={category}
                onChange={(e) => setCategory(e.target.value)}
              >
                <option value="">Select category…</option>
                {(categoriesQ.data ?? []).map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.label}
                  </option>
                ))}
              </SelectInput>
            </Field>
          </div>
          <div className="border-b border-line px-3.5 py-2.5">
            <Field
              label="VAT (EUR)"
              hint={
                docPolicy === 'none'
                  ? 'No receipt → input VAT is not deductible'
                  : `auto ${STANDARD_VAT_RATE_PCT}% — edit if the receipt says otherwise`
              }
            >
              <TextInput
                inputMode="decimal"
                value={docPolicy === 'none' ? '0.00' : vatInput}
                disabled={docPolicy === 'none'}
                onChange={(e) => setVatInput(e.target.value)}
              />
            </Field>
          </div>
          <KeyValue
            k="Tax point"
            v={`${fmtDate(tx.transaction_date)} · from the line`}
          />
        </div>

        <GroupLabel>Document</GroupLabel>
        <div className="mx-3.5 mb-3 overflow-hidden rounded-2xl bg-surface">
          {[
            {
              value: 'later' as const,
              icon: '📎',
              iconBg: 'bg-warn-bg',
              title: 'Receipt coming later',
              sub: 'Attach it in Books when it arrives',
            },
            {
              value: 'none' as const,
              icon: '🚫',
              iconBg: 'bg-line',
              title: 'No receipt',
              sub: 'The line is the source · VAT 0, not deductible',
            },
          ].map((opt) => {
            const on = docPolicy === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => setDocPolicy(opt.value)}
                className="flex w-full items-center gap-3 border-b border-line px-3.5 py-3 text-left last:border-b-0"
              >
                <span
                  aria-hidden
                  className={`flex h-[34px] w-[34px] flex-none items-center justify-center rounded-[10px] text-[15px] ${opt.iconBg}`}
                >
                  {opt.icon}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[14px] font-semibold">
                    {opt.title}
                  </div>
                  <div className="truncate text-[12px] text-ink-2">
                    {opt.sub}
                  </div>
                </div>
                <span
                  aria-hidden
                  className={`h-[22px] w-[22px] flex-none rounded-full border-2 ${
                    on
                      ? 'border-accent bg-[radial-gradient(circle,theme(colors.accent.DEFAULT)_42%,transparent_48%)]'
                      : 'border-chevron'
                  }`}
                />
              </button>
            );
          })}
        </div>
      </fieldset>
      {landed?.stagedMatchIds == null && (
        <ActionBar>
          <Button
            className="h-[46px] w-full"
            disabled={!valid}
            busy={busy}
            onClick={onSubmit}
          >
            {locked
              ? `Finish · expense #${landed?.expenseId}`
              : `Create & match · ${fmtCents(tx.amount)} €`}
          </Button>
        </ActionBar>
      )}
      <p className="px-6 pb-2 text-center text-[10.5px] leading-[1.4] text-ink-3">
        The amount and date come from the bank — they are facts, not fields
      </p>

      {/* Remount-on-open (epoch): a discarded new-supplier draft never
          comes back on the next open. */}
      {picker.epoch > 0 && (
        <SupplierSheet
          key={picker.epoch}
          open={picker.isOpen}
          onOpenChange={(o) => !o && picker.close()}
          tx={tx}
          onPick={setSupplier}
        />
      )}
    </PendingFieldset>
  );
}
