import { useEffect, useState } from 'react';
import {
  getDocumentDebug,
  manualClassify,
  getCategories,
  getEntities,
  type CategoryDef,
  type Entity,
} from '../api';

const toCents = (s: string): number => Math.round(parseFloat(s) * 100);
const fromCents = (n: number): string => (n / 100).toFixed(2);

const CURRENCIES = ['EUR', 'DKK', 'USD', 'GBP', 'SEK', 'NOK'] as const;

const VAT_MARKINGS = [
  { value: '', label: 'None' },
  { value: 'S', label: 'S — Standard' },
  { value: 'Z', label: 'Z — Zero-rated' },
  { value: 'E', label: 'E — Exempt' },
] as const;

export function TriageManualForm({
  documentId,
  onDone,
  onCancel,
}: {
  documentId: number;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [categories, setCategories] = useState<CategoryDef[]>([]);
  const [suppliers, setSuppliers] = useState<Entity[]>([]);

  // Form fields
  const [supplierId, setSupplierId] = useState<number | null>(null);
  const [category, setCategory] = useState('');
  const [vatMarking, setVatMarking] = useState('');
  const [grossAmount, setGrossAmount] = useState('');
  const [vatAmount, setVatAmount] = useState('');
  const [currency, setCurrency] = useState('EUR');
  const [taxPointDate, setTaxPointDate] = useState('');
  const [invoiceNumber, setInvoiceNumber] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([
      getDocumentDebug(documentId),
      getCategories(),
      getEntities(),
    ])
      .then(([debug, cats, entities]) => {
        if (cancelled) return;
        setCategories(cats);
        const supplierList = entities.filter((e) => e.role === 'supplier');
        setSuppliers(supplierList);

        // Pre-fill from AI classification if available
        if (debug.classification?.ok) {
          const r = debug.classification.result;
          setGrossAmount(fromCents(r.gross_amount));
          setVatAmount(fromCents(r.vat_amount));
          setCurrency(r.currency || 'EUR');
          setTaxPointDate(r.tax_point_date || '');
          setCategory(r.category || '');
          setVatMarking(r.document_vat_marking ?? '');
        }
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [documentId]);

  const handleSubmit = async () => {
    setError(null);

    // Validate required fields
    if (supplierId == null) {
      setError('Supplier is required.');
      return;
    }
    if (!category) {
      setError('Category is required.');
      return;
    }
    if (!taxPointDate) {
      setError('Date is required.');
      return;
    }
    if (!grossAmount || isNaN(parseFloat(grossAmount))) {
      setError('Gross amount must be a valid number.');
      return;
    }
    if (!vatAmount || isNaN(parseFloat(vatAmount))) {
      setError('VAT amount must be a valid number.');
      return;
    }

    setBusy(true);
    try {
      await manualClassify(documentId, {
        supplier_id: supplierId,
        category,
        document_vat_marking: vatMarking || null,
        gross_amount: toCents(grossAmount),
        vat_amount: toCents(vatAmount),
        currency,
        tax_point_date: taxPointDate,
        supplier_invoice_number: invoiceNumber || null,
      });
      onDone();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="border rounded p-3 text-sm text-gray-500">Loading…</div>
    );
  }

  if (!loading && error && suppliers.length === 0 && categories.length === 0) {
    return (
      <div className="p-3 space-y-2 text-sm bg-red-50 border-t border-red-200">
        <p className="text-red-700 text-xs">Failed to load form: {error}</p>
        <button
          type="button"
          onClick={onCancel}
          className="text-gray-600 hover:underline text-sm"
        >
          Close
        </button>
      </div>
    );
  }

  return (
    <div className="border rounded p-3 space-y-3 text-sm bg-gray-50">
      <p className="text-gray-700 font-medium">Manual classification</p>

      <div className="grid grid-cols-2 gap-2">
        {/* Supplier */}
        <label className="flex flex-col col-span-2">
          Supplier <span className="text-red-500">*</span>
          <select
            className="border rounded px-2 py-1"
            value={supplierId ?? ''}
            onChange={(e) =>
              setSupplierId(e.target.value ? Number(e.target.value) : null)
            }
          >
            <option value="">Select a supplier…</option>
            {suppliers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.country})
              </option>
            ))}
          </select>
        </label>

        {/* Category */}
        <label className="flex flex-col col-span-2">
          Category <span className="text-red-500">*</span>
          <select
            className="border rounded px-2 py-1"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
          >
            <option value="">Select a category…</option>
            {categories.map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
              </option>
            ))}
          </select>
        </label>

        {/* Gross amount */}
        <label className="flex flex-col">
          Gross amount <span className="text-red-500">*</span>
          <input
            type="number"
            step="0.01"
            min="0"
            className="border rounded px-2 py-1"
            value={grossAmount}
            onChange={(e) => setGrossAmount(e.target.value)}
          />
        </label>

        {/* VAT amount */}
        <label className="flex flex-col">
          VAT amount <span className="text-red-500">*</span>
          <input
            type="number"
            step="0.01"
            min="0"
            className="border rounded px-2 py-1"
            value={vatAmount}
            onChange={(e) => setVatAmount(e.target.value)}
          />
        </label>

        {/* Currency */}
        <label className="flex flex-col">
          Currency
          <select
            className="border rounded px-2 py-1"
            value={currency}
            onChange={(e) => setCurrency(e.target.value)}
          >
            {CURRENCIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>

        {/* Date */}
        <label className="flex flex-col">
          Date <span className="text-red-500">*</span>
          <input
            type="date"
            className="border rounded px-2 py-1"
            value={taxPointDate}
            onChange={(e) => setTaxPointDate(e.target.value)}
          />
        </label>

        {/* VAT marking */}
        <label className="flex flex-col">
          VAT marking
          <select
            className="border rounded px-2 py-1"
            value={vatMarking}
            onChange={(e) => setVatMarking(e.target.value)}
          >
            {VAT_MARKINGS.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </label>

        {/* Invoice number */}
        <label className="flex flex-col">
          Invoice number (optional)
          <input
            type="text"
            className="border rounded px-2 py-1"
            value={invoiceNumber}
            onChange={(e) => setInvoiceNumber(e.target.value)}
          />
        </label>
      </div>

      {error && <p className="text-red-600">{error}</p>}

      <div className="space-x-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => void handleSubmit()}
          className="bg-black text-white rounded px-3 py-1 disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Save & classify'}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onCancel}
          className="text-gray-600 hover:underline"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
