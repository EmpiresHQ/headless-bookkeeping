import { useEffect, useState } from 'react';
import {
  getInvoices,
  createInvoice,
  deleteInvoice,
  correctInvoice,
  fmtCents,
  type SalesInvoice,
  type CorrectionRequest,
} from '../api';
import {
  Field,
  CorrectionForm,
  eurosToCents,
  type CorrectionDraft,
} from './corrections-form';
import { Table, type Column } from './Table';

interface NewInvoice {
  invoice_number: string;
  gross: string;
  vat: string;
  currency: string;
  tax_point_date: string;
}

const blank: NewInvoice = {
  invoice_number: '',
  gross: '',
  vat: '',
  currency: 'EUR',
  tax_point_date: '',
};

export function InvoicesView() {
  const [rows, setRows] = useState<SalesInvoice[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<NewInvoice>(blank);
  const [correctId, setCorrectId] = useState<number | null>(null);
  const [correction, setCorrection] = useState<CorrectionDraft | null>(null);

  const load = () =>
    getInvoices()
      .then(setRows)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));

  useEffect(() => {
    void load();
  }, []);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onAdd = () =>
    run(async () => {
      await createInvoice({
        invoice_number: form.invoice_number.trim(),
        gross_amount: eurosToCents(form.gross),
        vat_amount: eurosToCents(form.vat),
        currency: form.currency.trim(),
        tax_point_date: form.tax_point_date,
      });
      setForm(blank);
      setNote('Invoice created.');
    });

  const startCorrect = (i: SalesInvoice) => {
    setCorrectId(i.id);
    setCorrection({
      kind: 'financial',
      reason: '',
      gross: (i.gross_amount / 100).toFixed(2),
      vat: (i.vat_amount / 100).toFixed(2),
      category: '',
    });
  };

  const submitCorrect = (id: number) =>
    run(async () => {
      if (!correction) return;
      const req: CorrectionRequest = {
        kind: correction.kind,
        reason: correction.reason.trim(),
        patch: {
          gross_amount: eurosToCents(correction.gross),
          vat_amount: eurosToCents(correction.vat),
        },
      };
      await correctInvoice(id, req);
      setCorrectId(null);
      setCorrection(null);
      setNote('Correction posted.');
    });

  const onDelete = (i: SalesInvoice) =>
    run(async () => {
      if (!window.confirm(`Delete draft invoice #${i.id}?`)) return;
      await deleteInvoice(i.id);
    });

  const addValid =
    form.invoice_number.trim() !== '' && form.tax_point_date.trim() !== '';

  const columns: Column<SalesInvoice>[] = [
    { header: 'No.', cell: (i) => i.invoice_number },
    {
      header: 'Gross',
      cell: (i) => (
        <span className="tabular-nums">
          {fmtCents(i.gross_amount)} {i.currency}
        </span>
      ),
    },
    {
      header: 'VAT',
      cell: (i) => (
        <span className="tabular-nums">{fmtCents(i.vat_amount)}</span>
      ),
    },
    { header: 'Tax point', cell: (i) => i.tax_point_date },
    { header: 'Status', cell: (i) => i.status },
    { header: 'Sent', cell: (i) => (i.sent_at ? 'yes' : 'no') },
    {
      header: 'Bank',
      cell: (i) =>
        i.reconciled ? (
          <span className="text-green-700">reconciled</span>
        ) : (
          <span className="text-gray-400">—</span>
        ),
    },
  ];

  return (
    <div className="p-4 space-y-6 text-sm">
      {error && <p className="text-red-600">{error}</p>}
      {note && <p className="text-green-700">{note}</p>}

      <section className="space-y-2">
        <h2 className="font-medium text-gray-700">Add sales invoice</h2>
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Invoice no.">
            <input
              aria-label="Invoice number"
              value={form.invoice_number}
              onChange={(e) =>
                setForm({ ...form, invoice_number: e.target.value })
              }
              className="border rounded px-2 py-1"
            />
          </Field>
          <Field label="Gross (€)">
            <input
              aria-label="Gross"
              type="number"
              step="0.01"
              value={form.gross}
              onChange={(e) => setForm({ ...form, gross: e.target.value })}
              className="border rounded px-2 py-1 w-28 tabular-nums"
            />
          </Field>
          <Field label="VAT (€)">
            <input
              aria-label="VAT"
              type="number"
              step="0.01"
              value={form.vat}
              onChange={(e) => setForm({ ...form, vat: e.target.value })}
              className="border rounded px-2 py-1 w-28 tabular-nums"
            />
          </Field>
          <Field label="Currency">
            <input
              aria-label="Currency"
              value={form.currency}
              onChange={(e) => setForm({ ...form, currency: e.target.value })}
              className="border rounded px-2 py-1 w-20 uppercase"
            />
          </Field>
          <Field label="Tax point">
            <input
              aria-label="Tax point date"
              type="date"
              value={form.tax_point_date}
              onChange={(e) =>
                setForm({ ...form, tax_point_date: e.target.value })
              }
              className="border rounded px-2 py-1"
            />
          </Field>
          <button
            type="button"
            disabled={busy || !addValid}
            onClick={() => void onAdd()}
            className="bg-black text-white rounded px-3 py-1 disabled:opacity-50"
          >
            Add
          </button>
        </div>
      </section>

      <section>
        <Table
          columns={columns}
          rows={rows}
          actions={(i) => (
            <div className="space-x-3 whitespace-nowrap">
              {i.status === 'draft' && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void onDelete(i)}
                  className="text-red-600 hover:underline disabled:opacity-50"
                >
                  Delete
                </button>
              )}
              {i.status === 'posted' && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => startCorrect(i)}
                  className="text-amber-700 hover:underline disabled:opacity-50"
                >
                  Correct
                </button>
              )}
            </div>
          )}
        />
      </section>

      {correctId !== null && correction && (
        <CorrectionForm
          draft={correction}
          busy={busy}
          showCategory={false}
          onChange={setCorrection}
          onCancel={() => {
            setCorrectId(null);
            setCorrection(null);
          }}
          onSubmit={() => void submitCorrect(correctId)}
          title={`Correct invoice #${correctId}`}
        />
      )}
    </div>
  );
}
