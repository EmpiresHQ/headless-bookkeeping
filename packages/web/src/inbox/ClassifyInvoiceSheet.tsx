import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  getDocumentReclassify,
  manualClassifyInvoice,
  type Entity,
  type TriageOutcome,
} from '../api';
import { STANDARD_VAT_RATE_PCT } from '../bank/format';
import { centsToEuroInput, eurosToCents, vatFromGross } from '../lib/money';
import { inboxKeys } from '../queries/inbox';
import { useCustomers } from '../queries/shared';
import { Button } from '../ui/Button';
import { Field, SelectInput, TextInput } from '../ui/Form';
import { SearchInput } from '../ui/SearchInput';
import { Sheet } from '../ui/Sheet';
import { toastErr } from '../ui/toast';

const CURRENCIES = ['EUR', 'DKK', 'USD', 'GBP', 'SEK', 'NOK'] as const;
const VAT_MARKINGS = [
  { value: '', label: 'None' },
  { value: 'S', label: 'S — Standard' },
  { value: 'Z', label: 'Z — Zero-rated' },
  { value: 'E', label: 'E — Exempt' },
] as const;

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

  const [customer, setCustomer] = useState<Entity | null>(null);
  const [search, setSearch] = useState('');
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [gross, setGross] = useState('');
  const [vat, setVat] = useState('');
  const [vatTouched, setVatTouched] = useState(false);
  const [currency, setCurrency] = useState('EUR');
  const [date, setDate] = useState('');
  const [vatMarking, setVatMarking] = useState('');
  const [prefilled, setPrefilled] = useState(false);
  const [busy, setBusy] = useState(false);

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
      setPrefilled(true);
    }
  }, [reclassifyQ.data, prefilled]);

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
  const valid =
    invoiceNumber.trim() !== '' &&
    date !== '' &&
    grossCents !== null &&
    grossCents > 0 &&
    vatCents !== null &&
    vatCents >= 0;

  const submit = async () => {
    if (!valid || grossCents === null || vatCents === null) return;
    setBusy(true);
    try {
      onDone(
        await manualClassifyInvoice(documentId, {
          target: 'sales_invoice',
          customer_id: customer?.id ?? null,
          invoice_number: invoiceNumber.trim(),
          document_vat_marking: vatMarking !== '' ? vatMarking : null,
          gross_amount: grossCents,
          vat_amount: vatCents,
          currency,
          tax_point_date: date,
        }),
      );
    } catch (e) {
      toastErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const matches = (customersQ.data ?? [])
    .filter((c) => c.name.toLowerCase().includes(search.toLowerCase()))
    .slice(0, 5);

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Record sales invoice">
      <div className="space-y-3 px-5 pb-2">
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

        <Field label="Customer (optional)">
          {customer === null ? (
            <>
              <SearchInput
                value={search}
                onChange={setSearch}
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
                {matches.length === 0 && (
                  <p className="px-3.5 py-2.5 text-[12.5px] text-ink-2">
                    No matches — leave empty if unknown
                  </p>
                )}
              </div>
            </>
          ) : (
            <div className="flex items-center justify-between rounded-xl border border-line bg-surface px-3 py-2.5">
              <span className="text-[15px] font-semibold">{customer.name}</span>
              <button
                type="button"
                onClick={() => setCustomer(null)}
                className="text-[13px] font-semibold text-accent"
              >
                Change
              </button>
            </div>
          )}
        </Field>

        <Field label="Invoice number">
          <TextInput
            value={invoiceNumber}
            onChange={(e) => setInvoiceNumber(e.target.value)}
          />
        </Field>

        <div className="flex gap-2.5">
          <div className="flex-1">
            <Field label="Amount (EUR)">
              <TextInput
                aria-label="Amount (EUR)"
                inputMode="decimal"
                value={gross}
                onChange={(e) => onGrossChange(e.target.value)}
              />
            </Field>
          </div>
          <div className="flex-1">
            <Field label="VAT">
              <TextInput
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
            <Field label="Date">
              <TextInput
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </Field>
          </div>
          <div className="flex-1">
            <Field label="Currency">
              <SelectInput
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

        <Field label="VAT marking">
          <SelectInput
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

        <Button
          className="w-full"
          busy={busy}
          disabled={!valid}
          onClick={() => void submit()}
        >
          {grossCents !== null && grossCents > 0
            ? `Record invoice · +${(grossCents / 100).toFixed(2)} €`
            : 'Record invoice'}
        </Button>
      </div>
    </Sheet>
  );
}
