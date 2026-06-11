import { useEffect, useState } from 'react';
import {
  getExpenses,
  createExpense,
  deleteExpense,
  correctExpense,
  fmtCents,
  type Expense,
  type CorrectionRequest,
} from '../api';
import {
  Field,
  CorrectionForm,
  eurosToCents,
  type CorrectionDraft,
} from './corrections-form';
import { Table, type Column } from './Table';

interface NewExpense {
  category: string;
  gross: string;
  vat: string;
  currency: string;
  tax_point_date: string;
}

const blank: NewExpense = {
  category: '',
  gross: '',
  vat: '',
  currency: 'EUR',
  tax_point_date: '',
};

export function ExpensesView() {
  const [rows, setRows] = useState<Expense[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<NewExpense>(blank);
  const [correctId, setCorrectId] = useState<number | null>(null);
  const [correction, setCorrection] = useState<CorrectionDraft | null>(null);

  const load = () =>
    getExpenses()
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
      await createExpense({
        category: form.category.trim(),
        gross_amount: eurosToCents(form.gross),
        vat_amount: eurosToCents(form.vat),
        currency: form.currency.trim(),
        tax_point_date: form.tax_point_date,
      });
      setForm(blank);
      setNote('Expense created.');
    });

  const startCorrect = (e: Expense) => {
    setCorrectId(e.id);
    setCorrection({
      kind: 'financial',
      reason: '',
      gross: (e.gross_amount / 100).toFixed(2),
      vat: (e.vat_amount / 100).toFixed(2),
      category: e.category,
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
          category: correction.category.trim(),
        },
      };
      await correctExpense(id, req);
      setCorrectId(null);
      setCorrection(null);
      setNote('Correction posted.');
    });

  const onDelete = (e: Expense) =>
    run(async () => {
      if (!window.confirm(`Delete draft expense #${e.id}?`)) return;
      await deleteExpense(e.id);
    });

  const addValid =
    form.category.trim() !== '' && form.tax_point_date.trim() !== '';

  const columns: Column<Expense>[] = [
    { header: 'ID', cell: (e) => e.id },
    { header: 'Category', cell: (e) => e.category },
    {
      header: 'Gross',
      cell: (e) => (
        <span className="tabular-nums">
          {fmtCents(e.gross_amount)} {e.currency}
        </span>
      ),
    },
    {
      header: 'VAT',
      cell: (e) => <span className="tabular-nums">{fmtCents(e.vat_amount)}</span>,
    },
    { header: 'Tax point', cell: (e) => e.tax_point_date },
    { header: 'Status', cell: (e) => e.status },
    {
      header: 'Bank',
      cell: (e) =>
        e.reconciled ? (
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
        <h2 className="font-medium text-gray-700">Add expense</h2>
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Category">
            <input
              aria-label="Category"
              value={form.category}
              onChange={(e) => setForm({ ...form, category: e.target.value })}
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
          actions={(e) => (
            <div className="space-x-3 whitespace-nowrap">
              {e.status === 'draft' && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void onDelete(e)}
                  className="text-red-600 hover:underline disabled:opacity-50"
                >
                  Delete
                </button>
              )}
              {e.status === 'posted' && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => startCorrect(e)}
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
          onChange={setCorrection}
          onCancel={() => {
            setCorrectId(null);
            setCorrection(null);
          }}
          onSubmit={() => void submitCorrect(correctId)}
          title={`Correct expense #${correctId}`}
        />
      )}
    </div>
  );
}
