import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  fmtCents,
  lockPeriod,
  type PeriodWarning,
  type ReportingPeriod,
} from '../api';
import { entityName } from '../queries/books';
import {
  invalidateReports,
  netVatLabel,
  periodTitle,
  usePeriodWarnings,
} from '../queries/reports';
import { useEntities, useExpenses, useInvoices } from '../queries/shared';
import { Button } from '../ui/Button';
import { Field, TextInput } from '../ui/Form';
import { Sheet } from '../ui/Sheet';
import { toastErr, toastOk } from '../ui/toast';

/**
 * The ADR-0015 filing guard: surface every unresolved in-period item, state
 * the consequences in human terms, and require an explicit TYPED confirm —
 * but never hard-block (deadlines are real; a straggler is handled next
 * period). Non-optimistic: plan → confirm → receipt. There is no unlock
 * (Reality #3) and the copy says so.
 */
export function LockSheet({
  period,
  netVatDueCents,
  open,
  onOpenChange,
}: {
  period: ReportingPeriod;
  netVatDueCents: number | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const qc = useQueryClient();
  const [typed, setTyped] = useState('');
  const warningsQ = usePeriodWarnings(period.id, open);
  const expensesQ = useExpenses();
  const invoicesQ = useInvoices();
  const entitiesQ = useEntities();

  const warnings = warningsQ.data ?? [];
  const expenses = expensesQ.data ?? [];
  const invoices = invoicesQ.data ?? [];
  const entities = entitiesQ.data ?? [];

  /** Human line per straggler, joined from the cached lists — the server
   *  `description` embeds raw cents and is never rendered (Reality #8). */
  const warningLine = (w: PeriodWarning): string => {
    const suffix =
      w.type === 'pending_approval' ? 'awaiting approval' : 'still a draft';
    if (w.object_type === 'expense') {
      const e = expenses.find((x) => x.id === w.object_id);
      if (e !== undefined) {
        const who = entityName(entities, e.supplier_id) ?? e.category;
        return `${who} · −${fmtCents(e.gross_amount)} € — ${suffix}`;
      }
      return `Expense — ${suffix}`;
    }
    const inv = invoices.find((x) => x.id === w.object_id);
    if (inv !== undefined) {
      const who = entityName(entities, inv.customer_id) ?? inv.invoice_number;
      return `${who} · +${fmtCents(inv.gross_amount)} € — ${suffix}`;
    }
    return `Invoice — ${suffix}`;
  };

  const lock = useMutation({
    mutationFn: () => lockPeriod(period.id),
    onSuccess: async () => {
      await invalidateReports(qc);
      toastOk(`${periodTitle(period.name)} closed — declaration frozen`);
      onOpenChange(false);
    },
    onError: (e) =>
      toastErr(e instanceof Error ? e.message : 'Could not close the period'),
  });

  const confirmLabel =
    netVatDueCents !== null
      ? `Close & freeze · ${netVatLabel(netVatDueCents)} ${fmtCents(Math.abs(netVatDueCents))} €`
      : 'Close & freeze the declaration';

  // Refuse to close while the lock mutation is in flight: vaul's
  // backdrop/swipe dismissal would otherwise unmount this component mid-
  // mutation, losing the onSuccess invalidate + receipt toast — worst here,
  // where the server has just locked the period and the UI would silently
  // keep showing it open.
  const guardedOnOpenChange = (o: boolean) => {
    if (lock.isPending && !o) return;
    onOpenChange(o);
  };

  return (
    <Sheet
      open={open}
      onOpenChange={guardedOnOpenChange}
      title={`Close ${periodTitle(period.name)}`}
    >
      <div className="space-y-3 px-6">
        <ul className="list-disc space-y-1 pl-5 text-[13.5px] text-ink-2">
          <li>The declaration is frozen exactly as shown and filed as-is.</li>
          <li>
            Anything dated {period.start_date} – {period.end_date} will be
            rejected after closing.
          </li>
          <li>
            Late documents and corrections are re-dated into the next open
            period and surface in that return.
          </li>
          <li>
            There is no unlock. A mistake is fixed forward with a correction in
            the open period — never by reopening this one.
          </li>
        </ul>
        {warnings.length > 0 && (
          <div className="rounded-2xl bg-warn-bg px-4 py-3">
            <p className="text-[13px] font-semibold text-warn">
              Not decided yet — closing strands these until they are resolved in
              a later period:
            </p>
            <ul className="mt-1 space-y-0.5 text-[13px] text-warn">
              {warnings.map((w) => (
                <li key={`${w.object_type}-${w.object_id}-${w.type}`}>
                  {warningLine(w)}
                </li>
              ))}
            </ul>
          </div>
        )}
        <Field label={`Type ${period.name} to confirm`}>
          <TextInput
            aria-label={`Type ${period.name} to confirm`}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={period.name}
          />
        </Field>
        <Button
          className="w-full"
          disabled={typed.trim() !== period.name}
          busy={lock.isPending}
          onClick={() => lock.mutate()}
        >
          {confirmLabel}
        </Button>
      </div>
    </Sheet>
  );
}
