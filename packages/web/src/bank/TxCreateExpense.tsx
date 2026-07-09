import { useState } from 'react';
import { fmtCents, type BankTransaction, type Entity } from '../api';
import {
  createExpenseFromLine,
  useCategories,
  type CreateFromLineResult,
} from '../queries/bank';
import { centsToEuroInput, eurosToCents, vatFromGross } from '../lib/money';
import { Button } from '../ui/Button';
import { Field, SelectInput, TextInput } from '../ui/Form';
import { GroupLabel, KeyValue } from '../ui/List';
import { toastErr } from '../ui/toast';
import { STANDARD_VAT_RATE_PCT } from './format';
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
  onDone,
}: {
  statementId: number;
  tx: BankTransaction;
  onDone: (r: CreateFromLineResult) => void;
}) {
  const absCents = Math.abs(tx.amount);
  const categoriesQ = useCategories();
  const [category, setCategory] = useState('');
  const [supplier, setSupplier] = useState<Entity | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [docPolicy, setDocPolicy] = useState<'later' | 'none'>('later');
  const [vatInput, setVatInput] = useState(() =>
    centsToEuroInput(vatFromGross(absCents, STANDARD_VAT_RATE_PCT)),
  );
  const [busy, setBusy] = useState(false);

  const vatCents = docPolicy === 'none' ? 0 : eurosToCents(vatInput);
  const valid =
    category !== '' &&
    vatCents !== null &&
    vatCents >= 0 &&
    vatCents <= absCents;

  const onSubmit = async () => {
    if (vatCents === null) return;
    setBusy(true);
    try {
      const result = await createExpenseFromLine({
        statementId,
        bankTransactionId: tx.id,
        category,
        grossCents: absCents,
        vatCents,
        currency: tx.currency,
        taxPointDate: tx.transaction_date,
        supplierId: supplier?.id ?? null,
      });
      onDone(result);
    } catch (e) {
      toastErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <GroupLabel>Create expense from line</GroupLabel>
      <div className="mx-3.5 mb-3 overflow-hidden rounded-2xl bg-surface">
        <button
          type="button"
          onClick={() => setPickerOpen(true)}
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
                <div className="truncate text-[12px] text-ink-2">{opt.sub}</div>
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

      <div className="sticky bottom-0 bg-gradient-to-t from-bg via-bg/95 to-transparent px-4 pb-3.5 pt-3">
        <Button
          className="h-[46px] w-full"
          disabled={!valid}
          busy={busy}
          onClick={() => void onSubmit()}
        >
          Create &amp; match · {fmtCents(tx.amount)} €
        </Button>
      </div>
      <p className="px-6 pb-2 text-center text-[10.5px] leading-[1.4] text-ink-3">
        The amount and date come from the bank — they are facts, not fields
      </p>

      <SupplierSheet
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        tx={tx}
        onPick={setSupplier}
      />
    </>
  );
}
