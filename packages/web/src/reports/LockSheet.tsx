import { useState, type RefObject } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  fmtCents,
  lockPeriod,
  type PeriodWarning,
  type ReportingPeriod,
} from '../api';
import { signedEuros } from '../lib/money';
import { entityName } from '../queries/books';
import {
  invalidateReports,
  netVatLabel,
  periodTitle,
  useKmd,
  usePeriodWarnings,
} from '../queries/reports';
import { useEntities, useExpenses, useInvoices } from '../queries/shared';
import { Button } from '../ui/Button';
import { Field, PendingFieldset, TextInput } from '../ui/Form';
import { Sheet } from '../ui/Sheet';
import { toastErr, toastOk } from '../ui/toast';
import { usePendingOperation } from '../lib/pendingOperation';
import { useUnsavedChanges } from '../lib/unsavedChanges';
import {
  checkError,
  checkSignature,
  checkState,
  retryFailed,
  type CheckQuery,
  type CheckState,
} from './checkStatus';

/**
 * The ADR-0015 filing guard: surface every unresolved in-period item, state
 * the consequences in human terms, and require an explicit TYPED confirm —
 * but never hard-block (deadlines are real; a straggler is handled next
 * period). Non-optimistic: plan → confirm → receipt. There is no unlock
 * (Reality #3) and the copy says so.
 *
 * Issue #255: every open re-runs the checks (the sheet remounts per open
 * epoch, so its query observers are new: a result cached before this open —
 * however recent — counts as "checking" until one lands after it,
 * `isFetchedAfterMount`).
 * When a check is incomplete — still checking, unavailable or only a stale
 * result — that is stated per check with a scoped Retry, the declaration
 * amount is not claimed, and closing needs an EXTRA explicit acknowledgement
 * bound to exactly that incomplete set. Still never a hard block; the lock
 * request itself is unchanged and the server stays authoritative.
 */
export function LockSheet({
  period,
  open,
  onOpenChange,
  returnFocusFallback,
}: {
  period: ReportingPeriod;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Focus target on close once closing the period removed the trigger. */
  returnFocusFallback?: RefObject<HTMLElement | null>;
}) {
  const qc = useQueryClient();
  const [typed, setTyped] = useState('');
  const guard = useUnsavedChanges({
    label: 'Close period',
    active: open,
    values: typed,
    baseline: '',
  });
  const warningsQ = usePeriodWarnings(period.id, open, {
    refetchOnMount: 'always',
  });
  const kmdQ = useKmd(period.id, open, { refetchOnMount: 'always' });
  const expensesQ = useExpenses();
  const invoicesQ = useInvoices();
  const entitiesQ = useEntities();

  // Required checks. Expenses/invoices/entities only enrich straggler labels
  // (a missing name falls back to "Expense — …") and are NOT required.
  // Freshness: only a result landing after this open's observers mounted —
  // the forced on-open refetch, or an in-flight one it joins — counts
  // (`checkState(…, true)`). The per-epoch remount means it never carries.
  const checks: {
    key: string;
    label: string;
    state: CheckState;
    queries: CheckQuery[];
  }[] = [
    {
      key: 'warnings',
      label: 'Undecided items',
      state: checkState([warningsQ], true),
      queries: [warningsQ],
    },
    {
      key: 'kmd',
      label: 'Declaration amount',
      state: checkState([kmdQ], true),
      queries: [kmdQ],
    },
  ];
  const incomplete = checks.filter((c) => c.state !== 'checked');
  const signature = checkSignature(checks);
  // The acknowledgement is stored AS the signature it was given for: any new
  // failure / retry outcome / different incomplete set voids it silently-safe
  // (unchecked again), and the per-open remount voids it across periods.
  const [ackFor, setAckFor] = useState<string | null>(null);
  const acknowledged = incomplete.length === 0 || ackFor === signature;
  const kmdChecked = checks[1].state === 'checked';
  const netVatDueCents =
    kmdChecked && kmdQ.data !== undefined ? kmdQ.data.net_vat_due : null;

  const warnings = warningsQ.data ?? [];
  // Optional enrichment (supplier/customer, amount) — separate from the
  // authoritative server count above; its failure is labeled, not a check.
  const enrichmentQs = [expensesQ, invoicesQ, entitiesQ];
  const failedEnrichment = enrichmentQs.filter((q) => q.isError);
  const detailsNote =
    warnings.length === 0 || failedEnrichment.length === 0
      ? null
      : `${
          failedEnrichment.some((q) => q.data === undefined)
            ? 'Some item details (names and amounts) unavailable'
            : 'Item details (names and amounts) could not be refreshed and may be out of date'
        } — ${
          checks[0].state === 'checked'
            ? 'the count comes from the server check and is complete.'
            : 'the count is the last loaded result; whether it is current is unknown.'
        }`;
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
        return `${who} · ${signedEuros(-e.gross_amount)} — ${suffix}`;
      }
      return `Expense — ${suffix}`;
    }
    const inv = invoices.find((x) => x.id === w.object_id);
    if (inv !== undefined) {
      const who = entityName(entities, inv.customer_id) ?? inv.invoice_number;
      return `${who} · ${signedEuros(inv.gross_amount)} — ${suffix}`;
    }
    return `Invoice — ${suffix}`;
  };

  const op = usePendingOperation('Close period');
  const busy = op.pending;
  const ready = typed.trim() === period.name && acknowledged && !busy;
  const lock = () => {
    // Enforced here too, not only by the disabled button.
    if (!ready) return;
    const perform = () => lockPeriod(period.id);
    op.run(
      async (ctx) => {
        const result = await perform();
        ctx.check();
        await invalidateReports(qc);
        return result;
      },
      {
        onSuccess: () => {
          toastOk(`${periodTitle(period.name)} closed — declaration frozen`);
          guard.release();
          onOpenChange(false);
        },
        onError: (e) =>
          toastErr(
            e instanceof Error ? e.message : 'Could not close the period',
          ),
      },
    );
  };

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
    if (busy && !o) return;
    onOpenChange(o);
  };

  return (
    <Sheet
      open={open}
      onOpenChange={guardedOnOpenChange}
      title={`Close ${periodTitle(period.name)}`}
      guard={guard}
      busy={busy}
      returnFocusFallback={returnFocusFallback}
    >
      <PendingFieldset pending={busy} className="space-y-3 px-6">
        <ul className="list-disc space-y-1 pl-5 text-[13.5px] text-ink-2">
          <li>
            {kmdChecked
              ? 'The declaration is frozen exactly as shown and filed as-is.'
              : 'The declaration is frozen as the server computes it at closing — it could not be shown here.'}
          </li>
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
        <div className="rounded-2xl bg-surface px-4 py-3">
          <p className="text-[13px] font-semibold">Pre-close checks</p>
          <ul className="mt-1 space-y-1.5 text-[13px]">
            {checks.map((c) => (
              <li
                key={c.key}
                className="flex items-center justify-between gap-3"
              >
                <span>
                  {c.label}:{' '}
                  <span className={c.state === 'checked' ? '' : 'text-warn'}>
                    {checkLine(c.key, c.state, c.queries, warnings.length)}
                  </span>
                </span>
                {(c.state === 'unavailable' || c.state === 'stale') && (
                  <Button
                    variant="secondary"
                    aria-label={`Retry ${c.label.toLowerCase()}`}
                    onClick={() => retryFailed(c.queries, true)}
                  >
                    Retry
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </div>
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
            {detailsNote !== null && (
              <div className="mt-1.5 flex items-center justify-between gap-3">
                <p className="text-[12px] text-warn">{detailsNote}</p>
                <Button
                  variant="secondary"
                  onClick={() =>
                    failedEnrichment.forEach((q) => void q.refetch())
                  }
                >
                  Retry details
                </Button>
              </div>
            )}
          </div>
        )}
        {incomplete.length > 0 && (
          <label className="flex items-start gap-2 rounded-2xl bg-warn-bg px-4 py-3 text-[13px] text-warn">
            <input
              type="checkbox"
              checked={ackFor === signature}
              onChange={(e) => setAckFor(e.target.checked ? signature : null)}
            />
            <span>
              Close anyway without complete checks — I understand undecided
              items{kmdChecked ? '' : ' and the declaration amount'} may be
              missing from this summary.
            </span>
          </label>
        )}
        <Field label={`Type ${period.name} to confirm`}>
          <TextInput
            aria-label={`Type ${period.name} to confirm`}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={period.name}
          />
        </Field>
        <Button className="w-full" disabled={!ready} busy={busy} onClick={lock}>
          {confirmLabel}
        </Button>
      </PendingFieldset>
    </Sheet>
  );
}

function checkLine(
  key: string,
  state: CheckState,
  queries: CheckQuery[],
  warningCount: number,
): string {
  const err = checkError(queries);
  switch (state) {
    case 'checking':
      return 'checking…';
    case 'unavailable':
      return `could not check${err !== null ? ` — ${err}` : ''}`;
    case 'stale':
      return `could not refresh${err !== null ? ` — ${err}` : ''}; earlier result shown`;
    case 'checked':
      if (key === 'kmd') return 'recomputed now';
      return warningCount === 0 ? 'none found' : `${warningCount} found below`;
  }
}
