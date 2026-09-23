import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { fmtCents, type BankTransaction } from '../api';
import { HttpError } from '../auth';
import {
  BookingPartialError,
  createExpenseFromLine,
  invalidateStatement,
  newFromLineProgress,
  useCategories,
  useSuppliers,
  type CreateFromLineResult,
  type FromLineProgress,
} from '../queries/bank';
import {
  amountError,
  centsToEuroInput,
  eurosToCents,
  vatFromGross,
} from '../lib/money';
import type { PendingOperation } from '../lib/pendingOperation';
import { useResultLog, writeChain, type ChainSlot } from '../lib/resultLog';
import { useUnsavedChanges } from '../lib/unsavedChanges';
import { useSheet } from '../lib/useSheet';
import { ActionBar } from '../ui/ActionBar';
import { Button } from '../ui/Button';
import {
  Field,
  FormErrorSummary,
  PendingFieldset,
  SelectInput,
  TextInput,
  useFormErrors,
} from '../ui/Form';
import { GroupLabel, KeyValue, READABLE } from '../ui/List';
import {
  BlockedReason,
  lookupBlocker,
  lookupState,
  LookupNotice,
  NO_CATEGORIES,
  useEntityPick,
} from '../ui/Lookup';
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
  const suppliersQ = useSuppliers();
  // Checked against the supplier list (#260): a supplier the SupplierSheet
  // just created is authoritative over a cached list that predates it, but
  // a list successfully fetched after the creation that lacks it — like any
  // later list that drops a picked one (deleted / role changed) — shows it
  // as unavailable (useEntityPick).
  const supplierPick = useEntityPick(suppliersQ);
  const supplier = supplierPick.entity;
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
  const values = {
    category,
    supplierId: supplier?.id ?? null,
    docPolicy,
    vatInput,
  };
  const [baseline] = useState(values);
  const guard = useUnsavedChanges({
    label: 'Expense from bank line',
    values,
    baseline,
    active: !locked,
  });

  const vatCents = docPolicy === 'none' ? 0 : eurosToCents(vatInput);
  // Issue #260: a loading/failed list is not an empty one — the category
  // must be one the list offers, and "no supplier" is an answer only against
  // a usable supplier list. Once the expense exists (locked) its facts are
  // the server's and a lookup no longer gates finishing the chain.
  const categories = categoriesQ.data;
  const categoryGone =
    category !== '' &&
    categories !== undefined &&
    !categories.some((c) => c.key === category);
  const blocker = locked
    ? null
    : (lookupBlocker(categoriesQ, 'categories') ??
      (categories?.length === 0 ? NO_CATEGORIES : null) ??
      (categoryGone
        ? 'The chosen category is no longer available — choose again.'
        : null) ??
      // A picked (or just created) supplier is itself the answer; only
      // "no supplier" needs the list to be known.
      (supplier === null ? lookupBlocker(suppliersQ, 'suppliers') : null) ??
      (supplierPick.gone
        ? 'The chosen supplier is no longer available — choose again.'
        : null));
  // Field feedback (issue #265). VAT <= the line amount is this form's own
  // rule (the line IS the gross), not the create endpoint's. Once the
  // expense exists (`locked`) its facts are the server's: no field check
  // may stand between the operator and finishing THAT expense's chain.
  const fieldValues = {
    supplier: supplier?.id ?? null,
    category,
    vat: docPolicy === 'none' ? '0.00' : vatInput,
  };
  const v = useFormErrors({
    off: locked,
    values: fieldValues,
    errors: {
      supplier: null,
      category: category === '' ? 'Choose a category' : null,
      vat:
        docPolicy === 'none'
          ? null
          : (amountError(vatInput, {
              blank: 'Enter the VAT — 0.00 if there is none',
              sign: 'nonNegative',
              what: 'VAT',
            }) ??
            (vatCents !== null && vatCents > absCents
              ? `VAT cannot exceed the line amount (${fmtCents(absCents)})`
              : null)),
    },
    labels: { supplier: 'Supplier', category: 'Category', vat: 'VAT (EUR)' },
    // Mapped only when the create stage itself was refused (see onError).
    serverFields: {
      supplier_id: 'supplier',
      category: 'category',
      vat_amount: 'vat',
    },
  });

  const onSubmit = () => {
    if (blocker !== null || !v.attempt() || vatCents === null) return;
    const sent = fieldValues;
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
          // Stated in the form too (issue #265) — truthfully per stage: a
          // refused CREATE maps to the fields; after it, the expense exists
          // and nothing is mapped (its facts are no longer the form's).
          if (p.expenseId === null) {
            v.failed(
              e,
              sent,
              e instanceof HttpError &&
                e.validation === null &&
                [400, 409, 422].includes(e.status)
                ? 'Not created — the server refused this expense. Your input is kept.'
                : undefined,
            );
          } else {
            v.failed(
              e,
              null,
              `Expense #${p.expenseId} is already saved, but a later step did not complete — see above. Retrying finishes the remaining steps for that expense.`,
            );
          }
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
            id={v.idOf('supplier')}
            type="button"
            onClick={() => picker.open()}
            className="flex w-full items-center justify-between gap-3 border-b border-line px-3.5 py-2.5 text-left"
          >
            <span className="text-[13px] text-ink-2">Supplier</span>
            <span
              className={`min-w-0 text-right text-[13px] font-semibold ${READABLE} ${
                supplierPick.gone ? 'text-err' : ''
              }`}
            >
              {supplier
                ? supplierPick.gone
                  ? `${supplier.name} — no longer available ›`
                  : supplier.name
                : 'Choose or create ›'}
            </span>
          </button>
          {lookupState(suppliersQ) !== 'ready' && (
            <div className="border-b border-line px-3.5 pb-2.5">
              <LookupNotice query={suppliersQ} what="suppliers" />
            </div>
          )}
          <div className="border-b border-line px-3.5 py-2.5">
            <Field
              label="Category"
              required
              error={
                categoryGone
                  ? 'This category is no longer available — choose again'
                  : categories?.length === 0
                    ? NO_CATEGORIES
                    : v.error('category')
              }
            >
              <SelectInput
                {...v.bind('category')}
                value={category}
                onChange={(e) => setCategory(e.target.value)}
              >
                <option value="">
                  {categories === undefined
                    ? lookupState(categoriesQ) === 'loading'
                      ? 'Loading categories…'
                      : 'Categories unavailable'
                    : categories.length === 0
                      ? 'No categories defined'
                      : 'Select category…'}
                </option>
                {categoryGone && (
                  <option value={category}>{category} (not available)</option>
                )}
                {(categories ?? []).map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.label}
                  </option>
                ))}
              </SelectInput>
            </Field>
            <LookupNotice query={categoriesQ} what="categories" />
          </div>
          <div className="border-b border-line px-3.5 py-2.5">
            <Field
              label="VAT (EUR)"
              required={docPolicy !== 'none'}
              error={v.error('vat')}
              hint={
                docPolicy === 'none'
                  ? 'No receipt → input VAT is not deductible'
                  : `auto ${STANDARD_VAT_RATE_PCT}% — edit if the receipt says otherwise`
              }
            >
              <TextInput
                {...v.bind('vat')}
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
          <FormErrorSummary form={v} blocked={blocker !== null} />
          <Button
            className="h-[46px] w-full"
            disabled={blocker !== null}
            busy={busy}
            onClick={onSubmit}
          >
            {locked
              ? `Finish · expense #${landed?.expenseId}`
              : `Create & match · ${fmtCents(tx.amount)} €`}
          </Button>
          <BlockedReason reason={blocker} />
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
          onPick={(e, created) => supplierPick.set(e, { created })}
        />
      )}
    </PendingFieldset>
  );
}
