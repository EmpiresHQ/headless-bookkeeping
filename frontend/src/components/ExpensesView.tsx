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

      <section className="overflow-x-auto">
        <table className="min-w-full border-collapse">
          <thead>
            <tr className="border-b bg-gray-50 text-left">
              <th className="px-3 py-2 font-medium text-gray-700">ID</th>
              <th className="px-3 py-2 font-medium text-gray-700">Category</th>
              <th className="px-3 py-2 font-medium text-gray-700">Gross</th>
              <th className="px-3 py-2 font-medium text-gray-700">VAT</th>
              <th className="px-3 py-2 font-medium text-gray-700">Tax point</th>
              <th className="px-3 py-2 font-medium text-gray-700">Status</th>
              <th className="px-3 py-2 font-medium text-gray-700">Bank</th>
              <th className="px-3 py-2 font-medium text-gray-700">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((e) => (
              <tr key={e.id} className="border-b align-top">
                <td className="px-3 py-2">{e.id}</td>
                <td className="px-3 py-2">{e.category}</td>
                <td className="px-3 py-2 tabular-nums">
                  {fmtCents(e.gross_amount)} {e.currency}
                </td>
                <td className="px-3 py-2 tabular-nums">
                  {fmtCents(e.vat_amount)}
                </td>
                <td className="px-3 py-2">{e.tax_point_date}</td>
                <td className="px-3 py-2">{e.status}</td>
                <td className="px-3 py-2">
                  {e.reconciled ? (
                    <span className="text-green-700">reconciled</span>
                  ) : (
                    <span className="text-gray-400">—</span>
                  )}
                </td>
                <td className="px-3 py-2 space-x-3 whitespace-nowrap">
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
                </td>
              </tr>
            ))}
          </tbody>
        </table>
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
