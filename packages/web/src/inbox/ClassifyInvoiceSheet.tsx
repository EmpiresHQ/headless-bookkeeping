import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  getDocumentReclassify,
  manualClassifyInvoice,
  type TriageOutcome,
} from '../api';
import { STANDARD_VAT_RATE_PCT } from '../bank/format';
import {
  amountError,
  centsToEuroInput,
  eurosToCents,
  signedEuros,
  vatFromGross,
} from '../lib/money';
import { errorMessage, usePendingOperation } from '../lib/pendingOperation';
import { useUnsavedChanges } from '../lib/unsavedChanges';
import { inboxKeys } from '../queries/inbox';
import { useCustomers } from '../queries/shared';
import { Button } from '../ui/Button';
import {
  Field,
  FormErrorSummary,
  PendingFieldset,
  SelectInput,
  TextInput,
  useFormErrors,
} from '../ui/Form';
import { toastErr } from '../ui/toast';
import {
  BlockedReason,
  lookupBlocker,
  lookupState,
  LookupNotice,
  useEntityPick,
} from '../ui/Lookup';
import { SearchInput } from '../ui/SearchInput';
import { Sheet } from '../ui/Sheet';
import { DocumentSourcePane } from './DocumentSourcePane';

const CURRENCIES = ['EUR', 'DKK', 'USD', 'GBP', 'SEK', 'NOK'] as const;
const VAT_MARKINGS = [
  { value: '', label: 'None' },
  { value: 'S', label: 'S — Standard' },
  { value: 'Z', label: 'Z — Zero-rated' },
  { value: 'E', label: 'E — Exempt' },
] as const;

const EMPTY_INVOICE = {
  customerId: null as number | null,
  invoiceNumber: '',
  gross: '',
  vat: '',
  currency: 'EUR',
  date: '',
  vatMarking: '',
};

/** Triage flow — a document the AI recognized as YOUR outgoing invoice.
 *  Records it as a sales invoice (customer optional). Same prefill-first
 *  shape as ClassifyExpenseSheet. */
export function ClassifyInvoiceSheet({
  documentId,
  open,
  onOpenChange,
  onDone,
}: {
  documentId: number;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onDone: (o: TriageOutcome) => void;
}) {
  const reclassifyQ = useQuery({
    queryKey: inboxKeys.reclassify(documentId),
    queryFn: () => getDocumentReclassify(documentId),
    enabled: open,
    staleTime: Infinity,
  });
  const customersQ = useCustomers();

  // Checked against the customer list (#260): a picked customer a later
  // list no longer has stays shown and must be changed.
  const customerPick = useEntityPick(customersQ);
  const customer = customerPick.entity;
  const setCustomer = customerPick.set;
  const [search, setSearch] = useState('');
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [gross, setGross] = useState('');
  const [vat, setVat] = useState('');
  const [vatTouched, setVatTouched] = useState(false);
  const [currency, setCurrency] = useState('EUR');
  const [date, setDate] = useState('');
  const [vatMarking, setVatMarking] = useState('');
  const [prefilled, setPrefilled] = useState(false);
  const op = usePendingOperation('Record sales invoice');
  const busy = op.pending;
  // What the prefill offered, committed with it (see ClassifyExpenseSheet).
  const [prefillBase, setPrefillBase] = useState(EMPTY_INVOICE);

  // Prefill runs once the AI data lands — via FUNCTIONAL updates, so it only
  // ever fills a field that is still at its untouched default. The reclassify
  // fetch can resolve well after mount (it re-runs OCR+LLM server-side), so an
  // operator may already be typing by the time this effect fires; a plain
  // `setGross(aiValue)` would silently stomp on what they just entered. Each
  // updater reads the LATEST state at apply time, so this is race-safe
  // regardless of when the query settles relative to user input. (Same fix
  // applied in ClassifyExpenseSheet — the brief's literal code here used the
  // naive direct-set pattern.)
  useEffect(() => {
    const c = reclassifyQ.data?.classification;
    if (!prefilled && c != null && c.ok) {
      setGross((cur) =>
        cur === '' ? centsToEuroInput(c.result.gross_amount) : cur,
      );
      setVat((cur) =>
        cur === '' ? centsToEuroInput(c.result.vat_amount) : cur,
      );
      setCurrency((cur) =>
        cur === 'EUR'
          ? c.result.currency !== ''
            ? c.result.currency
            : 'EUR'
          : cur,
      );
      setDate((cur) => (cur === '' ? c.result.tax_point_date : cur));
      setVatMarking((cur) =>
        cur === '' ? (c.result.document_vat_marking ?? '') : cur,
      );
      setInvoiceNumber((cur) =>
        cur === '' ? (c.result.supplier_invoice_number ?? '') : cur,
      );
      setPrefillBase({
        ...EMPTY_INVOICE,
        invoiceNumber: c.result.supplier_invoice_number ?? '',
        gross: centsToEuroInput(c.result.gross_amount),
        vat: centsToEuroInput(c.result.vat_amount),
        currency: c.result.currency !== '' ? c.result.currency : 'EUR',
        date: c.result.tax_point_date,
        vatMarking: c.result.document_vat_marking ?? '',
      });
      setPrefilled(true);
    }
  }, [reclassifyQ.data, prefilled]);

  // The customer search is a filter. Values are compared as displayed.
  const guard = useUnsavedChanges({
    label: 'Record sales invoice',
    active: open,
    values: {
      customerId: customer?.id ?? null,
      invoiceNumber,
      gross,
      vat,
      currency,
      date,
      vatMarking,
    },
    baseline: prefillBase,
  });

  const onGrossChange = (v: string) => {
    setGross(v);
    if (!vatTouched) {
      const cents = eurosToCents(v);
      if (cents !== null && cents > 0) {
        setVat(centsToEuroInput(vatFromGross(cents, STANDARD_VAT_RATE_PCT)));
      }
    }
  };

  const grossCents = eurosToCents(gross);
  const vatCents = eurosToCents(vat);
  // Issue #260: "no customer" is an answer only against a usable list.
  const blocker =
    (customer === null ? lookupBlocker(customersQ, 'customers') : null) ??
    (customerPick.gone
      ? 'The chosen customer is no longer available — change it or leave it empty.'
      : null);
  // Field feedback (issue #265). The rules are the ones this form already
  // held (a sales invoice's number, gross > 0, VAT >= 0 — the sales-invoice
  // create contract), now stated at the field instead of a dead button.
  const fieldValues = {
    customer: customer?.id ?? null,
    number: invoiceNumber,
    gross,
    vat,
    date,
    currency,
    vatMarking,
  };
  const v = useFormErrors({
    values: fieldValues,
    errors: {
      customer: null,
      number: invoiceNumber.trim() === '' ? 'Enter the invoice number' : null,
      gross: amountError(gross, {
        blank: 'Enter the amount',
        sign: 'positive',
        what: 'The amount',
      }),
      vat: amountError(vat, {
        blank: 'Enter the VAT — 0.00 if there is none',
        sign: 'nonNegative',
        what: 'VAT',
      }),
      date: date === '' ? 'Pick the date' : null,
      currency: null,
      vatMarking: null,
    },
    labels: {
      customer: 'Customer',
      number: 'Invoice number',
      gross: 'Amount (EUR)',
      vat: 'VAT',
      date: 'Date',
      currency: 'Currency',
      vatMarking: 'VAT marking',
    },
    serverFields: {
      customer_id: 'customer',
      invoice_number: 'number',
      gross_amount: 'gross',
      vat_amount: 'vat',
      tax_point_date: 'date',
      currency: 'currency',
      document_vat_marking: 'vatMarking',
    },
  });

  const submit = () => {
    if (blocker !== null || !v.attempt()) return;
    if (grossCents === null || vatCents === null) return;
    const sent = fieldValues;
    const req = {
      target: 'sales_invoice' as const,
      customer_id: customer?.id ?? null,
      invoice_number: invoiceNumber.trim(),
      document_vat_marking: vatMarking !== '' ? vatMarking : null,
      gross_amount: grossCents,
      vat_amount: vatCents,
      currency,
      tax_point_date: date,
    };
    op.run(() => manualClassifyInvoice(documentId, req), {
      onSuccess: (outcome) => {
        guard.release();
        onDone(outcome);
      },
      onError: (e) => {
        toastErr(errorMessage(e));
        // Kept in the form, at the field the server named (issue #265).
        v.failed(e, sent);
      },
    });
  };

  const matches = (customersQ.data ?? [])
    .filter((c) => c.name.toLowerCase().includes(search.toLowerCase()))
    .slice(0, 5);

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title="Record sales invoice"
      guard={guard}
      source={<DocumentSourcePane documentId={documentId} active={open} />}
      busy={busy}
    >
      <PendingFieldset pending={busy} className="space-y-3 px-5 pb-2">
        {reclassifyQ.isPending && (
          <p className="text-[13px] text-ink-2">
            Re-reading the document (OCR + AI)… this can take a minute
          </p>
        )}
        {reclassifyQ.isError && (
          <p className="text-[13px] font-semibold text-err">
            {reclassifyQ.error instanceof Error
              ? reclassifyQ.error.message
              : 'AI prefill failed — fill in manually'}
          </p>
        )}

        <Field label="Customer (optional)" group error={v.error('customer')}>
          {customer === null ? (
            <>
              <SearchInput
                {...v.bind('customer')}
                value={search}
                onChange={setSearch}
                aria-label="Search customers"
                aria-invalid={v.error('customer') !== null ? true : undefined}
                placeholder="Search customers…"
              />
              <div className="mt-1 overflow-hidden rounded-xl bg-surface">
                {matches.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => setCustomer(c)}
                    className="flex w-full items-center justify-between border-b border-line px-3.5 py-2.5 text-left text-[14px] font-semibold last:border-b-0"
                  >
                    {c.name}
                    <span className="text-[12px] font-normal text-ink-2">
                      {c.country}
                    </span>
                  </button>
                ))}
                {customersQ.data !== undefined && matches.length === 0 && (
                  <p className="px-3.5 py-2.5 text-[12.5px] text-ink-2">
                    {lookupState(customersQ) === 'stale'
                      ? 'No matches in the list loaded earlier — it could not be refreshed'
                      : 'No matches — leave empty if unknown'}
                  </p>
                )}
              </div>
            </>
          ) : (
            <div className="flex items-center justify-between rounded-xl border border-line bg-surface px-3 py-2.5">
              <span
                className={`text-[15px] font-semibold ${customerPick.gone ? 'text-err' : ''}`}
              >
                {customer.name}
                {customerPick.gone && ' — no longer available'}
              </span>
              <button
                id={v.idOf('customer')}
                type="button"
                onClick={() => setCustomer(null)}
                className="text-[13px] font-semibold text-accent"
              >
                Change
              </button>
            </div>
          )}
        </Field>
        {/* Shown whatever is picked: a failed refresh is worth knowing. */}
        <LookupNotice query={customersQ} what="customers" />

        <Field label="Invoice number" required error={v.error('number')}>
          <TextInput
            {...v.bind('number')}
            value={invoiceNumber}
            onChange={(e) => setInvoiceNumber(e.target.value)}
          />
        </Field>

        <div className="flex gap-2.5">
          <div className="flex-1">
            <Field label="Amount (EUR)" required error={v.error('gross')}>
              <TextInput
                {...v.bind('gross')}
                aria-label="Amount (EUR)"
                inputMode="decimal"
                value={gross}
                onChange={(e) => onGrossChange(e.target.value)}
              />
            </Field>
          </div>
          <div className="flex-1">
            <Field
              label="VAT"
              required
              error={v.error('vat')}
              hint={
                vatTouched && vat.trim() === ''
                  ? 'Required — enter 0.00 if there is no VAT'
                  : undefined
              }
            >
              <TextInput
                {...v.bind('vat')}
                aria-label="VAT"
                inputMode="decimal"
                value={vat}
                onChange={(e) => {
                  setVatTouched(true);
                  setVat(e.target.value);
                }}
              />
            </Field>
          </div>
        </div>

        <div className="flex gap-2.5">
          <div className="flex-1">
            <Field label="Date" required error={v.error('date')}>
              <TextInput
                {...v.bind('date')}
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </Field>
          </div>
          <div className="flex-1">
            <Field label="Currency" error={v.error('currency')}>
              <SelectInput
                {...v.bind('currency')}
                value={currency}
                onChange={(e) => setCurrency(e.target.value)}
              >
                {CURRENCIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </SelectInput>
            </Field>
          </div>
        </div>

        <Field label="VAT marking" error={v.error('vatMarking')}>
          <SelectInput
            {...v.bind('vatMarking')}
            value={vatMarking}
            onChange={(e) => setVatMarking(e.target.value)}
          >
            {VAT_MARKINGS.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </SelectInput>
        </Field>

        <FormErrorSummary form={v} blocked={blocker !== null} />
        <Button
          className="w-full"
          busy={busy}
          disabled={blocker !== null}
          onClick={submit}
        >
          {grossCents !== null && grossCents > 0
            ? `Record invoice · ${signedEuros(grossCents)}`
            : 'Record invoice'}
        </Button>
        <BlockedReason reason={blocker} />
      </PendingFieldset>
    </Sheet>
  );
}
