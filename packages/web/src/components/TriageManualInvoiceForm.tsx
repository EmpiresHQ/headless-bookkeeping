import { useEffect, useState } from 'react';
import { manualClassifyInvoice, getEntities, type Entity } from '../api';

const toCents = (s: string): number => Math.round(parseFloat(s) * 100);

const CURRENCIES = ['EUR', 'DKK', 'USD', 'GBP', 'SEK', 'NOK'] as const;

const VAT_MARKINGS = [
  { value: '', label: 'None' },
  { value: 'S', label: 'S — Standard' },
  { value: 'Z', label: 'Z — Zero-rated' },
  { value: 'E', label: 'E — Exempt' },
] as const;

export function TriageManualInvoiceForm({
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

  const [customers, setCustomers] = useState<Entity[]>([]);

  // Form fields
  const [customerId, setCustomerId] = useState<number | null>(null);
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [vatMarking, setVatMarking] = useState('');
  const [grossAmount, setGrossAmount] = useState('');
  const [vatAmount, setVatAmount] = useState('');
  const [currency, setCurrency] = useState('EUR');
  const [taxPointDate, setTaxPointDate] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getEntities()
      .then((entities) => {
        if (cancelled) return;
        setCustomers(entities.filter((e) => e.role === 'customer'));
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

    if (!invoiceNumber) {
      setError('Invoice number is required.');
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
      await manualClassifyInvoice(documentId, {
        target: 'sales_invoice',
        customer_id: customerId,
        invoice_number: invoiceNumber,
        document_vat_marking: vatMarking || null,
        gross_amount: toCents(grossAmount),
        vat_amount: toCents(vatAmount),
        currency,
        tax_point_date: taxPointDate,
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

  if (!loading && error) {
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
      <p className="text-gray-700 font-medium">Classify as sales invoice</p>

      <div className="grid grid-cols-2 gap-2">
        {/* Customer (optional) */}
        <label className="flex flex-col col-span-2">
          Customer (optional)
          <select
            className="border rounded px-2 py-1"
            value={customerId ?? ''}
            onChange={(e) =>
              setCustomerId(e.target.value ? Number(e.target.value) : null)
            }
          >
            <option value="">Select a customer…</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.country})
              </option>
            ))}
          </select>
        </label>

        {/* Invoice number */}
        <label className="flex flex-col col-span-2">
          Invoice number <span className="text-red-500">*</span>
          <input
            type="text"
            className="border rounded px-2 py-1"
            value={invoiceNumber}
            onChange={(e) => setInvoiceNumber(e.target.value)}
          />
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
      </div>

      {error && <p className="text-red-600">{error}</p>}

      <div className="space-x-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => void handleSubmit()}
          className="bg-black text-white rounded px-3 py-1 disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Save as sales invoice'}
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
