import { useState } from 'react';
import {
  fmtCents,
  type AdvanceTaxInput,
  type AdvanceTaxTreatment,
  type BankTransaction,
} from '../api';
import { signedEuros } from '../lib/money';
import { Button } from '../ui/Button';
import { Field, SelectInput, TextInput } from '../ui/Form';
import { SegmentedControl } from '../ui/SegmentedControl';
import { GroupLabel } from '../ui/List';
import { Sheet } from '../ui/Sheet';

/** The "Or" group — alternatives are always reachable, never the accent. */
export function OrRow({ onClick }: { onClick: () => void }) {
  return (
    <>
      <GroupLabel>Or</GroupLabel>
      <div className="mx-3.5 mb-3 overflow-hidden rounded-2xl bg-surface">
        <button
          type="button"
          onClick={onClick}
          className="flex min-h-[44px] w-full items-center gap-3 px-3.5 py-2.5 text-left"
        >
          {/* sanctioned one-off (approved mockup), no token — Plan 06 Task 2 */}
          <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-[#4D534E]">
            Personal · Bank fee · Prepayment
          </span>
          <span aria-hidden className="flex-none text-base text-chevron">
            ›
          </span>
        </button>
      </div>
    </>
  );
}

/**
 * Disposition fan. Visibility is bound to the server contract:
 * personal → outflows only, open + matchless (endpoint 400s otherwise);
 * fee → composed create-expense (no fee endpoint), outflow + matchless;
 * prepayment → books the WHOLE line, so matchless lines only.
 */
export function OtherSheet({
  open,
  onOpenChange,
  tx,
  hasMatches,
  feeAvailable,
  busy,
  onPersonal,
  onFee,
  onPrepayment,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  tx: BankTransaction;
  hasMatches: boolean;
  feeAvailable: boolean;
  busy: boolean;
  onPersonal: () => void;
  onFee: () => void;
  onPrepayment: () => void;
}) {
  const options: { label: string; sub: string; onPick: () => void }[] = [];
  if (tx.amount < 0 && !hasMatches) {
    options.push({
      label: 'Personal',
      sub: 'Not business — becomes your debt to the company',
      onPick: onPersonal,
    });
    if (feeAvailable) {
      options.push({
        label: 'Bank fee',
        sub: `Bank-fee expense, VAT 0 · ${fmtCents(tx.amount)} €`,
        onPick: onFee,
      });
    }
  }
  if (tx.amount !== 0 && !hasMatches) {
    options.push({
      label: 'Prepayment',
      sub: `Whole line on account · ${fmtCents(Math.abs(tx.amount))} €`,
      onPick: onPrepayment,
    });
  }
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Other actions">
      <div className="px-4 pb-4">
        <div className="overflow-hidden rounded-2xl bg-surface">
          {options.map((o) => (
            <button
              key={o.label}
              type="button"
              disabled={busy}
              onClick={o.onPick}
              className="flex w-full items-center gap-3 border-b border-line px-3.5 py-3 text-left last:border-b-0 disabled:opacity-50"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-[14.5px] font-semibold">
                  {o.label}
                </div>
                <div className="truncate text-[12.5px] text-ink-2">{o.sub}</div>
              </div>
              <span aria-hidden className="flex-none text-base text-chevron">
                ›
              </span>
            </button>
          ))}
          {options.length === 0 && (
            <p className="px-3.5 py-3 text-[13px] text-ink-2">
              No dispositions apply — the line has matches or is incoming-only.
            </p>
          )}
        </div>
      </div>
    </Sheet>
  );
}

/**
 * §6★b — personal NEVER shows a chart of accounts (ADR-0001/0017): the
 * country plugin resolves the account; the operator sees consequences in
 * human words. The owner-debt running balance is not exposed by any endpoint
 * (degradation, see appendix) — the sheet explains without the number.
 * This sheet IS the explicit confirm: markPersonal posts immediately and has
 * no undo endpoint.
 */
export function PersonalSheet({
  open,
  onOpenChange,
  tx,
  busy,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  tx: BankTransaction;
  busy: boolean;
  onConfirm: () => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Personal spend">
      <p className="px-7 pb-2.5 text-center text-[12px] text-ink-2">
        {tx.description ?? 'Bank line'} · {fmtCents(tx.amount)} €
      </p>
      <div className="mx-4 mb-3 rounded-[13px] bg-warn-bg px-3.5 py-2.5 text-[12px] leading-[1.45] text-warn-deep">
        <b className="mb-0.5 block text-[11px] uppercase tracking-wide">
          What happens
        </b>
        This is not a company expense: it will not enter the P&amp;L and no VAT
        is deducted. The amount is recorded as your debt to the company — repay
        it by transfer or settle it against a payout.
      </div>
      <div className="flex gap-2.5 px-4 pb-4">
        <Button
          variant="secondary"
          className="h-[46px] flex-1"
          onClick={() => onOpenChange(false)}
        >
          Cancel
        </Button>
        <Button className="h-[46px] flex-1" busy={busy} onClick={onConfirm}>
          Record as personal
        </Button>
      </div>
      <p className="px-6 pb-3 text-center text-[10.5px] text-ink-3">
        One attributable tap — you are the approver; recorded in the audit log
      </p>
    </Sheet>
  );
}

/**
 * Whole-line prepayment — explicit confirm (posts immediately, no undo).
 *
 * For money RECEIVED the sheet also asks what it is (issue #213). Estonian VAT
 * arises on the earlier of the supply and the payment for it, so an advance on
 * an identified taxable supply owes its VAT on the day it arrives — and a
 * security deposit owes none. The system will not guess between them: an
 * unclassified receipt is recorded and then HELD, which the sheet says plainly
 * instead of promising a future match.
 *
 * Money PAID to a supplier is unchanged: it declares no output VAT, so it asks
 * nothing extra.
 */
export function PrepaymentSheet({
  open,
  onOpenChange,
  tx,
  busy,
  vatTreatments,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  tx: BankTransaction;
  busy: boolean;
  /** Treatments the country plugin allows for this receipt date. */
  vatTreatments: { vat_code: string; rate_permille: number }[];
  onConfirm: (tax?: AdvanceTaxInput) => void;
}) {
  const incoming = tx.amount > 0;
  const abs = fmtCents(Math.abs(tx.amount));
  const [treatment, setTreatment] = useState<AdvanceTaxTreatment>('unresolved');
  const [vatCode, setVatCode] = useState('');
  const [supply, setSupply] = useState('');
  const [documentNumber, setDocumentNumber] = useState('');

  const effectiveVatCode = vatCode || vatTreatments[0]?.vat_code || '';
  const rate = vatTreatments.find(
    (t) => t.vat_code === effectiveVatCode,
  )?.rate_permille;
  // The VAT inside the money received, at the rate in force on its date.
  const vatCents =
    rate === undefined
      ? null
      : Math.round((Math.abs(tx.amount) * rate) / (1000 + rate));

  const taxableIncomplete =
    treatment === 'taxable_supply' &&
    (supply.trim() === '' || effectiveVatCode === '');

  const submit = () => {
    if (!incoming) return onConfirm();
    if (treatment === 'unresolved') return onConfirm();
    onConfirm(
      treatment === 'taxable_supply'
        ? {
            tax_treatment: 'taxable_supply',
            vat_code: effectiveVatCode,
            supply_description: supply.trim(),
            ...(documentNumber.trim()
              ? { advance_document_number: documentNumber.trim() }
              : {}),
          }
        : { tax_treatment: 'non_taxable_deposit' },
    );
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Record prepayment">
      <p className="px-7 pb-2.5 text-center text-[12px] text-ink-2">
        {tx.description ?? 'Bank line'} · {incoming ? '+' : '−'}
        {abs} €
      </p>

      {incoming && (
        <div className="mx-4 mb-3 space-y-3">
          <Field
            group
            label="What is this money?"
            hint="A payment for an identified supply is taxed on the day it arrives — a deposit is not."
          >
            <SegmentedControl<AdvanceTaxTreatment>
              options={[
                { value: 'taxable_supply', label: 'Advance for a supply' },
                { value: 'non_taxable_deposit', label: 'Deposit' },
                { value: 'unresolved', label: 'Not sure yet' },
              ]}
              value={treatment}
              onChange={setTreatment}
            />
          </Field>

          {treatment === 'taxable_supply' && (
            <>
              <Field
                label="What was paid for"
                hint="The supply this advance pays for — it is what makes the payment taxable."
              >
                <TextInput
                  value={supply}
                  onChange={(e) => setSupply(e.target.value)}
                  placeholder="e.g. Website build, delivery in March"
                />
              </Field>
              <Field
                label="VAT treatment"
                hint={
                  vatTreatments.length === 0
                    ? 'No advance treatment is available for this date — record it as not sure yet and ask your accountant.'
                    : undefined
                }
              >
                <SelectInput
                  value={effectiveVatCode}
                  onChange={(e) => setVatCode(e.target.value)}
                  disabled={vatTreatments.length === 0}
                >
                  {vatTreatments.map((t) => (
                    <option key={t.vat_code} value={t.vat_code}>
                      {t.rate_permille / 10}% · {t.vat_code}
                    </option>
                  ))}
                </SelectInput>
              </Field>
              <Field
                label="Advance invoice number (if issued)"
                hint="Estonia expects the advance invoice within 7 days of the payment; the number is needed before the VAT return is filed."
              >
                <TextInput
                  value={documentNumber}
                  onChange={(e) => setDocumentNumber(e.target.value)}
                  placeholder="e.g. ETTEMAKS-12"
                />
              </Field>
            </>
          )}
        </div>
      )}

      <div className="mx-4 mb-3 rounded-[13px] bg-warn-bg px-3.5 py-2.5 text-[12px] leading-[1.45] text-warn-deep">
        <b className="mb-0.5 block text-[11px] uppercase tracking-wide">
          What happens
        </b>
        {!incoming &&
          `Records the whole ${abs} € as a supplier prepayment (money paid on account). It can settle bills later — future lines will offer it as a match candidate.`}
        {incoming && treatment === 'taxable_supply' && (
          <>
            Records {abs} € received as an advance on that supply.{' '}
            {vatCents === null
              ? 'Its VAT is declared on the date the money arrived.'
              : `${fmtCents(vatCents)} € of VAT is declared on the date the money arrived`}
            {vatCents === null
              ? ''
              : `, and ${fmtCents(Math.abs(tx.amount) - vatCents)} € is owed to the customer until the invoice.`}{' '}
            The final invoice releases that VAT once, so it is never declared
            twice.
          </>
        )}
        {incoming && treatment === 'non_taxable_deposit' && (
          <>
            Records the whole {abs} € as a deposit held for the customer. No VAT
            is declared, because no supply is being paid for. It can settle
            invoices later — future lines will offer it as a match candidate.
          </>
        )}
        {incoming && treatment === 'unresolved' && (
          <>
            Records the {abs} € received, but HOLDS it: until somebody says
            whether it pays for a supply, it cannot settle an invoice and the
            VAT return for this period cannot be filed. Choose one of the
            options above to settle it now — afterwards it takes a bookkeeper
            (API: POST /api/prepayments/&#123;id&#125;/tax-treatment).
          </>
        )}
      </div>

      <div className="flex gap-2.5 px-4 pb-4">
        <Button
          variant="secondary"
          className="h-[46px] flex-1"
          onClick={() => onOpenChange(false)}
        >
          Cancel
        </Button>
        <Button
          className="h-[46px] flex-1"
          busy={busy}
          disabled={taxableIncomplete}
          onClick={submit}
        >
          Record prepayment · {incoming ? '+' : '−'}
          {abs} €
        </Button>
      </div>
    </Sheet>
  );
}

/** Incoming line, no invoices — the prepayment state from the routing matrix.
 *  Owner-debt repayment has no endpoint (appendix) and is not offered. */
export function IncomingOpen({
  tx,
  onPrepayment,
}: {
  tx: BankTransaction;
  onPrepayment: () => void;
}) {
  return (
    <>
      <div className="mx-3.5 mb-3 rounded-[13px] bg-ok-bg px-3.5 py-2.5 text-[12px] leading-[1.45] text-ok">
        <b className="mb-0.5 block text-[11px] uppercase tracking-wide">
          Incoming payment, no open invoices
        </b>
        Record it as a customer prepayment. The next step asks what the money
        is: a payment for a supply is taxed on the day it arrived, a deposit is
        not, and an unclassified receipt is held until someone says which.
      </div>
      <div className="sticky bottom-0 bg-gradient-to-t from-bg via-bg/95 to-transparent px-4 pb-3.5 pt-3">
        <Button className="h-[46px] w-full" onClick={onPrepayment}>
          Record prepayment · {signedEuros(tx.amount)}
        </Button>
      </div>
    </>
  );
}
