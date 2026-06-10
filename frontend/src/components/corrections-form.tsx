import type { ReactNode } from 'react';

export const KINDS = ['cosmetic', 'financial', 'credit_note'] as const;

export const eurosToCents = (s: string): number =>
  Math.round(parseFloat(s || '0') * 100);

export interface CorrectionDraft {
  kind: (typeof KINDS)[number];
  reason: string;
  gross: string;
  vat: string;
  category: string;
}

export function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-gray-500">{label}</span>
      {children}
    </label>
  );
}

/**
 * Correction editor for a posted expense/invoice. Submitting posts a reversal +
 * a corrected entry on the backend; the original becomes `reversed`. `category`
 * is shown for expenses; harmless for invoices (the backend ignores it).
 */
export function CorrectionForm({
  draft,
  busy,
  title,
  showCategory = true,
  onChange,
  onCancel,
  onSubmit,
}: {
  draft: CorrectionDraft;
  busy: boolean;
  title: string;
  showCategory?: boolean;
  onChange: (d: CorrectionDraft) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  return (
    <section className="border rounded p-3 bg-amber-50 space-y-2">
      <h2 className="font-medium text-gray-700">{title}</h2>
      <p className="text-xs text-gray-500">
        Posts a reversal + a corrected entry; the original becomes reversed.
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Kind">
          <select
            aria-label="Correction kind"
            value={draft.kind}
            onChange={(e) =>
              onChange({
                ...draft,
                kind: e.target.value as CorrectionDraft['kind'],
              })
            }
            className="border rounded px-2 py-1"
          >
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </Field>
        <Field label="New gross (€)">
          <input
            aria-label="Correction gross"
            type="number"
            step="0.01"
            value={draft.gross}
            onChange={(e) => onChange({ ...draft, gross: e.target.value })}
            className="border rounded px-2 py-1 w-28 tabular-nums"
          />
        </Field>
        <Field label="New VAT (€)">
          <input
            aria-label="Correction vat"
            type="number"
            step="0.01"
            value={draft.vat}
            onChange={(e) => onChange({ ...draft, vat: e.target.value })}
            className="border rounded px-2 py-1 w-28 tabular-nums"
          />
        </Field>
        {showCategory && (
          <Field label="Category">
            <input
              aria-label="Correction category"
              value={draft.category}
              onChange={(e) => onChange({ ...draft, category: e.target.value })}
              className="border rounded px-2 py-1"
            />
          </Field>
        )}
      </div>
      <Field label="Reason">
        <input
          aria-label="Correction reason"
          value={draft.reason}
          onChange={(e) => onChange({ ...draft, reason: e.target.value })}
          placeholder="why this correction"
          className="border rounded px-2 py-1 w-full"
        />
      </Field>
      <div className="flex items-center gap-3">
        <button
          type="button"
          disabled={busy || draft.reason.trim() === ''}
          onClick={onSubmit}
          className="bg-black text-white rounded px-3 py-1 disabled:opacity-50"
        >
          Post correction
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="text-gray-600 hover:underline"
        >
          Cancel
        </button>
      </div>
    </section>
  );
}
