import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { setExpenseDocumentMetadata, type Expense } from '../api';
import { invalidateReports } from '../queries/reports';
import { Button } from '../ui/Button';
import { Field, TextInput } from '../ui/Form';
import { Sheet } from '../ui/Sheet';
import { toastErr, toastOk } from '../ui/toast';

/**
 * The INF fix-in-place: PATCH /api/expenses/:id/document-metadata — no
 * ledger impact; the server 400s if the period locked meanwhile (race) and
 * that text surfaces verbatim (Reality #12). Mounted per-expense (remount
 * discipline: rendered only while open, keyed by the caller).
 */
export function FixInvoiceNumberSheet({
  expense,
  supplierName,
  open,
  onOpenChange,
}: {
  expense: Expense;
  supplierName: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const qc = useQueryClient();
  const [value, setValue] = useState('');

  const save = useMutation({
    mutationFn: () =>
      setExpenseDocumentMetadata(expense.id, {
        supplier_invoice_number: value.trim(),
      }),
    onSuccess: async () => {
      await invalidateReports(qc);
      toastOk('Invoice number saved');
      onOpenChange(false);
    },
    onError: (e) =>
      toastErr(e instanceof Error ? e.message : 'Could not save the number'),
  });

  // Refuse to close while the patch mutation is in flight — a vaul
  // backdrop/swipe dismissal mid-mutation would unmount this component and
  // lose the onSuccess invalidate + receipt toast.
  const guardedOnOpenChange = (o: boolean) => {
    if (save.isPending && !o) return;
    onOpenChange(o);
  };

  return (
    <Sheet
      open={open}
      onOpenChange={guardedOnOpenChange}
      title={supplierName ?? 'Add invoice number'}
    >
      <div className="space-y-3 px-6">
        <p className="text-[13.5px] text-ink-2">
          The INF annex itemises this purchase — the tax authority wants the
          supplier's invoice number on it. Copy it from the source document.
        </p>
        <Field label="Supplier invoice number">
          <TextInput
            aria-label="Supplier invoice number"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="e.g. A-183"
          />
        </Field>
        <Button
          className="w-full"
          disabled={value.trim() === ''}
          busy={save.isPending}
          onClick={() => save.mutate()}
        >
          Save number
        </Button>
      </div>
    </Sheet>
  );
}
