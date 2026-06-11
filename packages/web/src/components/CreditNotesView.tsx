import { useEffect, useState } from 'react';
import { createCreditNote, listCreditNotes, type CreditNote } from '../api';
import { Table, type Column } from './Table';

export function CreditNotesView() {
  const [notes, setNotes] = useState<CreditNote[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // form state
  const [creditNoteNumber, setCreditNoteNumber] = useState('');
  const [objectType, setObjectType] = useState<'sales_invoice' | 'expense'>(
    'sales_invoice',
  );
  const [objectId, setObjectId] = useState('');
  const [grossAmount, setGrossAmount] = useState('');
  const [vatAmount, setVatAmount] = useState('');
  const [taxPointDate, setTaxPointDate] = useState('');

  const loadNotes = async () => {
    try {
      const result = await listCreditNotes();
      setNotes(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    void loadNotes();
  }, []);

  const onSubmit = async () => {
    setBusy(true);
    setError(null);
    try {
      const created = await createCreditNote({
        credit_note_number: creditNoteNumber,
        credits_object_type: objectType,
        credits_object_id: Number(objectId),
        gross_amount: Number(grossAmount),
        vat_amount: Number(vatAmount),
        tax_point_date: taxPointDate,
      });
      setNotes((prev) => [...prev, created]);
      setCreditNoteNumber('');
      setObjectId('');
      setGrossAmount('');
      setVatAmount('');
      setTaxPointDate('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const columns: Column<CreditNote>[] = [
    { header: 'Number', cell: (n) => n.credit_note_number },
    { header: 'Status', cell: (n) => n.status },
    { header: 'Gross', cell: (n) => (n.gross_amount / 100).toFixed(2) },
    { header: 'VAT', cell: (n) => (n.vat_amount / 100).toFixed(2) },
    {
      header: 'Credits',
      cell: (n) => `${n.credits_object_type} #${n.credits_object_id}`,
    },
  ];

  return (
    <div className="p-4 space-y-4">
      <div className="grid grid-cols-2 gap-2 max-w-lg">
        <label className="text-sm font-medium" htmlFor="cn-number">
          Credit note number
        </label>
        <input
          id="cn-number"
          aria-label="Credit note number"
          type="text"
          value={creditNoteNumber}
          onChange={(e) => setCreditNoteNumber(e.target.value)}
          className="border rounded px-2 py-1 text-sm"
        />

        <label className="text-sm font-medium" htmlFor="cn-object-type">
          Object type
        </label>
        <select
          id="cn-object-type"
          aria-label="Object type"
          value={objectType}
          onChange={(e) =>
            setObjectType(e.target.value as 'sales_invoice' | 'expense')
          }
          className="border rounded px-2 py-1 text-sm"
        >
          <option value="sales_invoice">Sales invoice</option>
          <option value="expense">Expense</option>
        </select>

        <label className="text-sm font-medium" htmlFor="cn-object-id">
          Object ID
        </label>
        <input
          id="cn-object-id"
          aria-label="Object ID"
          type="number"
          value={objectId}
          onChange={(e) => setObjectId(e.target.value)}
          className="border rounded px-2 py-1 text-sm"
        />

        <label className="text-sm font-medium" htmlFor="cn-gross">
          Gross amount
        </label>
        <input
          id="cn-gross"
          aria-label="Gross amount"
          type="number"
          value={grossAmount}
          onChange={(e) => setGrossAmount(e.target.value)}
          className="border rounded px-2 py-1 text-sm"
        />

        <label className="text-sm font-medium" htmlFor="cn-vat">
          VAT amount
        </label>
        <input
          id="cn-vat"
          aria-label="VAT amount"
          type="number"
          value={vatAmount}
          onChange={(e) => setVatAmount(e.target.value)}
          className="border rounded px-2 py-1 text-sm"
        />

        <label className="text-sm font-medium" htmlFor="cn-date">
          Tax point date
        </label>
        <input
          id="cn-date"
          aria-label="Tax point date"
          type="date"
          value={taxPointDate}
          onChange={(e) => setTaxPointDate(e.target.value)}
          className="border rounded px-2 py-1 text-sm"
        />
      </div>

      <button
        type="button"
        disabled={busy}
        onClick={() => void onSubmit()}
        className="bg-black text-white rounded px-3 py-1 text-sm disabled:opacity-50"
      >
        Issue credit note
      </button>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {notes.length > 0 && <Table columns={columns} rows={notes} />}
    </div>
  );
}
