import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  getDocumentReclassify,
  manualClassify,
  type Entity,
  type TriageOutcome,
} from '../api';
import { STANDARD_VAT_RATE_PCT } from '../bank/format';
import { centsToEuroInput, eurosToCents, vatFromGross } from '../lib/money';
import { inboxKeys } from '../queries/inbox';
import { useCategories, useExpenses, useSuppliers } from '../queries/shared';
import { Button } from '../ui/Button';
import { Field, SelectInput, TextInput } from '../ui/Form';
import { SearchInput } from '../ui/SearchInput';
import { Sheet } from '../ui/Sheet';
import { toastErr } from '../ui/toast';
import { signedEuros } from './format';

const CURRENCIES = ['EUR', 'DKK', 'USD', 'GBP', 'SEK', 'NOK'] as const;
const VAT_MARKINGS = [
  { value: '', label: 'None' },
  { value: 'S', label: 'S — Standard' },
  { value: 'Z', label: 'Z — Zero-rated' },
  { value: 'E', label: 'E — Exempt' },
] as const;

/**
 * Triage flows 2/3 (low confidence / unknown category) — asset §3:
 * everything the system knows is PREFILLED (fresh AI run — the sanctioned
 * reclassify endpoint, fetched once per open); the operator verifies, not
 * types. VAT auto-computes from gross at the standard rate until touched.
 * Category chips are recent-first; the "usually X · N of M" hint is computed
 * from the picked supplier's real expense history (client-side — no
 * classification-memory endpoint exists).
 */
export function ClassifyExpenseSheet({
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
    staleTime: Infinity, // ALWAYS re-runs the LLM server-side — fetch once
  });
  const categoriesQ = useCategories();
  const suppliersQ = useSuppliers();
  const expensesQ = useExpenses();

  const [supplier, setSupplier] = useState<Entity | null>(null);
  const [supplierSearch, setSupplierSearch] = useState('');
  const [category, setCategory] = useState('');
  const [gross, setGross] = useState('');
  const [vat, setVat] = useState('');
  const [vatTouched, setVatTouched] = useState(false);
  const [currency, setCurrency] = useState('EUR');
  const [date, setDate] = useState('');
  const [vatMarking, setVatMarking] = useState('');
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [showAllCats, setShowAllCats] = useState(false);
  const [prefilled, setPrefilled] = useState(false);
  const [busy, setBusy] = useState(false);

  // Prefill runs once the AI data lands — via FUNCTIONAL updates, so it only
  // ever fills a field that is still at its untouched default. The reclassify
  // fetch can resolve well after mount (it re-runs OCR+LLM server-side), so an
  // operator may already be typing by the time this effect fires; a plain
  // `setGross(aiValue)` would silently stomp on what they just entered. Each
  // updater reads the LATEST state at apply time, so this is race-safe
  // regardless of when the query settles relative to user input.
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
      setCategory((cur) => (cur === '' ? c.result.category : cur));
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

  const categories = categoriesQ.data ?? [];
  const expenses = expensesQ.data ?? [];

  // Recent-first chip ordering: latest tax_point_date per category key.
  const orderedCategories = useMemo(() => {
    const lastUsed = new Map<string, string>();
    for (const e of expenses) {
      const prev = lastUsed.get(e.category);
      if (prev === undefined || e.tax_point_date > prev) {
        lastUsed.set(e.category, e.tax_point_date);
      }
    }
    return [...categories].sort((a, b) =>
      (lastUsed.get(b.key) ?? '').localeCompare(lastUsed.get(a.key) ?? ''),
    );
  }, [categories, expenses]);

  const visibleCats = useMemo(() => {
    if (showAllCats) return orderedCategories;
    const top = orderedCategories.slice(0, 4);
    const selected = orderedCategories.find((c) => c.key === category);
    return selected !== undefined && !top.includes(selected)
      ? [selected, ...top.slice(0, 3)]
      : top;
  }, [orderedCategories, showAllCats, category]);

  // "Usually X · N of M" — real history of the picked supplier.
  const usuallyHint = useMemo(() => {
    if (supplier === null) return null;
    const es = expenses.filter((e) => e.supplier_id === supplier.id);
    if (es.length < 2) return null;
    const counts = new Map<string, number>();
    for (const e of es)
      counts.set(e.category, (counts.get(e.category) ?? 0) + 1);
    const [topKey, topCount] = [...counts.entries()].sort(
      (a, b) => b[1] - a[1],
    )[0];
    const label = categories.find((c) => c.key === topKey)?.label ?? topKey;
    return `Usually ${label} · ${topCount} of ${es.length}`;
  }, [supplier, expenses, categories]);

  const grossCents = eurosToCents(gross);
  const vatCents = eurosToCents(vat);
  const valid =
    supplier !== null &&
    category !== '' &&
    date !== '' &&
    grossCents !== null &&
    grossCents > 0 &&
    vatCents !== null &&
    vatCents >= 0;

  const submit = async () => {
    if (!valid || supplier === null || grossCents === null || vatCents === null)
      return;
    setBusy(true);
    try {
      onDone(
        await manualClassify(documentId, {
          supplier_id: supplier.id,
          category,
          document_vat_marking: vatMarking !== '' ? vatMarking : null,
          gross_amount: grossCents,
          vat_amount: vatCents,
          currency,
          tax_point_date: date,
          supplier_invoice_number: invoiceNumber !== '' ? invoiceNumber : null,
        }),
      );
    } catch (e) {
      toastErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const supplierMatches = (suppliersQ.data ?? [])
    .filter((s) => s.name.toLowerCase().includes(supplierSearch.toLowerCase()))
    .slice(0, 5);

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Classify">
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

        <Field label="Supplier">
          {supplier === null ? (
            <>
              <SearchInput
                value={supplierSearch}
                onChange={setSupplierSearch}
                placeholder="Search suppliers…"
              />
              <div className="mt-1 overflow-hidden rounded-xl bg-surface">
                {supplierMatches.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => setSupplier(s)}
                    className="flex w-full items-center justify-between border-b border-line px-3.5 py-2.5 text-left text-[14px] font-semibold last:border-b-0"
                  >
                    {s.name}
                    <span className="text-[12px] font-normal text-ink-2">
                      {s.country}
                    </span>
                  </button>
                ))}
                {supplierMatches.length === 0 && (
                  <p className="px-3.5 py-2.5 text-[12.5px] text-ink-2">
                    No matches — unknown suppliers go through “Resolve supplier”
                  </p>
                )}
              </div>
            </>
          ) : (
            <div className="flex items-center justify-between rounded-xl border border-line bg-surface px-3 py-2.5">
              <span className="text-[15px] font-semibold">{supplier.name}</span>
              <button
                type="button"
                onClick={() => setSupplier(null)}
                className="text-[13px] font-semibold text-accent"
              >
                Change
              </button>
            </div>
          )}
        </Field>

        <div className="flex gap-2.5">
          <div className="flex-1">
            <Field
              label="Amount (EUR)"
              hint={`from OCR · VAT auto at ${STANDARD_VAT_RATE_PCT}%`}
            >
              <TextInput
                aria-label="Amount (EUR)"
                inputMode="decimal"
                value={gross}
                onChange={(e) => onGrossChange(e.target.value)}
              />
            </Field>
          </div>
          <div className="flex-1">
            <Field label="VAT" hint="edit if the receipt differs">
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

        <Field label="Category" hint={usuallyHint ?? undefined} group>
          <div className="flex flex-wrap gap-1.5">
            {visibleCats.map((c) => (
              <button
                key={c.key}
                type="button"
                aria-label={c.label}
                aria-pressed={category === c.key}
                onClick={() => setCategory(c.key)}
                className={`rounded-full px-3 py-1.5 text-[12px] font-semibold ${
                  category === c.key
                    ? 'bg-accent-deep text-white'
                    : 'border border-line bg-surface text-ink-2'
                }`}
              >
                {c.label}
              </button>
            ))}
            {!showAllCats && orderedCategories.length > visibleCats.length && (
              <button
                type="button"
                aria-label="All…"
                onClick={() => setShowAllCats(true)}
                className="rounded-full border border-line bg-surface px-3 py-1.5 text-[12px] font-semibold text-ink-2"
              >
                All…
              </button>
            )}
          </div>
        </Field>

        <div className="flex gap-2.5">
          <div className="flex-1">
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
          </div>
          <div className="flex-1">
            <Field label="Invoice number">
              <TextInput
                value={invoiceNumber}
                onChange={(e) => setInvoiceNumber(e.target.value)}
              />
            </Field>
          </div>
        </div>

        <Button
          className="w-full"
          busy={busy}
          disabled={!valid}
          onClick={() => void submit()}
        >
          {grossCents !== null && grossCents > 0
            ? `Create expense · ${signedEuros(-grossCents)}`
            : 'Create expense'}
        </Button>
      </div>
    </Sheet>
  );
}
