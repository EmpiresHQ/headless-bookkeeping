import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { correctExpense, correctInvoice, type CorrectionRequest } from '../api';
import { centsToEuroInput, eurosToCents } from '../lib/money';
import { invalidateBooks } from '../queries/books';
import { useCategories } from '../queries/shared';
import { Button } from '../ui/Button';
import { Field, INPUT_CLS, SelectInput, TextInput } from '../ui/Form';
import { LinkButton } from '../ui/LinkButton';
import { Sheet } from '../ui/Sheet';
import { toastErr, toastOk } from '../ui/toast';

type Kind = 'financial' | 'cosmetic' | 'credit_note';

const EXPLAIN: Record<Kind, string> = {
  financial:
    'Posts a reversal + a corrected entry; this document becomes “corrected” and the new figures go live. If the original period is locked, both land in the current open period (ADR-0009).',
  cosmetic:
    'Fixes presentation only — nothing changes in the books. (The server records no changes for this yet; use it to leave a reasoned note.)',
  credit_note:
    'Issues a negative document against this one; the original stays posted. Opens the credit-note form with this document preselected.',
};

/**
 * The ADR-0009 correction sheet. Mount with key={objectId} — the sheet keeps
 * form state and must never leak it across objects. The credit-note branch
 * NAVIGATES to /books/credit-notes/new (the /correct credit_note branch
 * needs a payload this client deliberately never sends — Reality #5).
 */
export function CorrectSheet({
  open,
  onOpenChange,
  objectType,
  objectId,
  grossCents,
  vatCents,
  category,
  onDone,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  objectType: 'expense' | 'sales_invoice';
  objectId: number;
  grossCents: number;
  vatCents: number;
  /** Current category — expenses only; invoices pass undefined. */
  category?: string;
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const categoriesQ = useCategories();
  const [kind, setKind] = useState<Kind>('financial');
  const [gross, setGross] = useState(centsToEuroInput(grossCents));
  const [vat, setVat] = useState(centsToEuroInput(vatCents));
  const [cat, setCat] = useState(category ?? '');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const grossParsed = eurosToCents(gross);
  const vatParsed = eurosToCents(vat);
  const financialValid =
    grossParsed !== null &&
    grossParsed > 0 &&
    vatParsed !== null &&
    vatParsed >= 0;
  const canSubmit =
    reason.trim() !== '' && (kind === 'cosmetic' || financialValid);
  const sign = objectType === 'expense' ? '−' : '+';

  const submit = async () => {
    setBusy(true);
    try {
      const req: CorrectionRequest =
        kind === 'cosmetic'
          ? { kind: 'cosmetic', reason: reason.trim() }
          : {
              kind: 'financial',
              reason: reason.trim(),
              patch: {
                gross_amount: grossParsed as number,
                vat_amount: vatParsed as number,
                ...(objectType === 'expense' && cat !== ''
                  ? { category: cat }
                  : {}),
              },
            };
      const res =
        objectType === 'expense'
          ? await correctExpense(objectId, req)
          : await correctInvoice(objectId, req);
      await invalidateBooks(qc);
      if (res.outcome === 'unsupported_status') {
        // The object was corrected by someone/something else in the
        // meantime — corrections are one-shot (ADR-0009), so this request
        // did nothing. Show reality, not a false success receipt.
        toastErr(
          'Nothing changed — this document was already corrected (corrections are one-shot)',
        );
      } else if (res.redirected === true) {
        toastOk(
          'Correction landed in the current open period — the original period is locked',
        );
      } else if (kind === 'cosmetic') {
        toastOk(
          'Cosmetic note sent — not stored, nothing changed in the books',
        );
      } else {
        toastOk(
          `Correction posted · ${sign}${centsToEuroInput(grossParsed as number)} €`,
        );
      }
      onOpenChange(false);
      onDone();
    } catch (e) {
      toastErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Correct">
      <div className="space-y-3 px-5 pb-2">
        <div className="space-y-2">
          {(
            [
              ['financial', 'Financial — amounts or category are wrong'],
              ['cosmetic', 'Cosmetic — presentation only'],
              ['credit_note', 'Credit note — credit part or all of it'],
            ] as const
          ).map(([k, label]) => (
            <label
              key={k}
              className={`block rounded-xl border px-3.5 py-2.5 ${
                kind === k
                  ? 'border-accent bg-surface'
                  : 'border-line bg-surface'
              }`}
            >
              <span className="flex items-center gap-2 text-[14px] font-semibold">
                <input
                  type="radio"
                  name="correction-kind"
                  checked={kind === k}
                  onChange={() => setKind(k)}
                />
                {label}
              </span>
              <span className="mt-1 block text-[12px] text-ink-2">
                {EXPLAIN[k]}
              </span>
            </label>
          ))}
        </div>

        {kind === 'credit_note' ? (
          <LinkButton
            to={`/books/credit-notes/new?type=${objectType}&id=${objectId}`}
            className="w-full"
          >
            Open the credit-note form
          </LinkButton>
        ) : (
          <>
            {kind === 'financial' && (
              <>
                <Field label="New gross (€)">
                  <TextInput
                    inputMode="decimal"
                    value={gross}
                    onChange={(e) => setGross(e.target.value)}
                  />
                </Field>
                <Field label="New VAT (€)">
                  <TextInput
                    inputMode="decimal"
                    value={vat}
                    onChange={(e) => setVat(e.target.value)}
                  />
                </Field>
                {objectType === 'expense' && (
                  <Field label="Category">
                    <SelectInput
                      value={cat}
                      onChange={(e) => setCat(e.target.value)}
                    >
                      {/* Keep a predating category selectable so it is never lost */}
                      {cat !== '' &&
                        !(categoriesQ.data ?? []).some(
                          (c) => c.key === cat,
                        ) && <option value={cat}>{cat}</option>}
                      {(categoriesQ.data ?? []).map((c) => (
                        <option key={c.key} value={c.key}>
                          {c.label}
                        </option>
                      ))}
                    </SelectInput>
                  </Field>
                )}
              </>
            )}
            <Field
              label="Reason"
              hint={
                kind === 'cosmetic'
                  ? 'Required — not stored; write it for your own reference'
                  : 'Required — it lands in the audit trail'
              }
            >
              <textarea
                className={INPUT_CLS}
                rows={2}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Why this correction…"
              />
            </Field>
            <Button
              className="w-full"
              busy={busy}
              disabled={!canSubmit}
              onClick={() => void submit()}
            >
              {kind === 'cosmetic'
                ? 'Record cosmetic correction'
                : `Post correction · ${sign}${
                    grossParsed !== null ? centsToEuroInput(grossParsed) : gross
                  } €`}
            </Button>
          </>
        )}
      </div>
    </Sheet>
  );
}
