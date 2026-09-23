import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { deleteInvoice, fmtCents, postInvoice } from '../api';
import { absoluteDate, absoluteDateFromIso, vatRatePct } from '../inbox/format';
import { humanizePolicyReason } from '../inbox/reason';
import { signedEuros } from '../lib/money';
import { errorMessage, usePendingOperation } from '../lib/pendingOperation';
import { useReceipt } from '../lib/resultLog';
import { useSheet } from '../lib/useSheet';
import {
  entityName,
  invalidateBooks,
  useRejectedReason,
} from '../queries/books';
import { useEntities, useInvoices } from '../queries/shared';
import { PeriodOriginNotice, usePeriodOrigin } from '../reports/PeriodOrigin';
import { ScreenHeader } from '../shell/Headers';
import { AmountText } from '../ui/AmountText';
import { Button } from '../ui/Button';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { EmptyState, SkeletonRows } from '../ui/Feedback';
import { LinkButton } from '../ui/LinkButton';
import { KeyValue, ListGroup, ListRow } from '../ui/List';
import { LoadError, RefetchError } from '../ui/LoadError';
import { toastErr, toastOk } from '../ui/toast';
import { statusChip } from './chips';
import { CorrectSheet } from './CorrectSheet';
import { InvoiceEditSheet } from './EditDraftSheet';
import { PendingApproval } from './PendingApproval';
import { useScreenEntry } from '../lib/screenEntry';

/** /books/invoices/:id — facts come from the LIST row (no single-invoice
 *  endpoint exists, Reality #13; the row is cache-shared with the segment).
 *
 *  History rejected-row subtitle deliberately says "See the rejection
 *  notice above" rather than repeating the reason text — the banner above
 *  already renders `Rejected — {reason}` and duplicating the verbatim
 *  reason string here made findByText(/reason/) ambiguous (multiple
 *  matches). Same fix Task 5's ExpenseScreen applied for the identical bug. */
export function InvoiceScreen() {
  const { id: idParam } = useParams();
  const id = Number(idParam);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const invoicesQ = useInvoices();
  const entitiesQ = useEntities();
  const inv = (invoicesQ.data ?? []).find((i) => i.id === id);
  const rejectionQ = useRejectedReason(
    'sales_invoice',
    id,
    inv?.status === 'draft',
  );

  const correctSheet = useSheet();
  // Return target once a correction removed "Correct…" (issue #268).
  const correctedRef = useRef<HTMLParagraphElement>(null);
  const editSheet = useSheet();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const op = usePendingOperation('Invoice');
  const receipt = useReceipt();
  const busy = op.pending;
  useScreenEntry(!invoicesQ.isPending);
  // Opened from a period drill-down list (issue #261): say so, offer the
  // way back, and return there after a delete instead of global Books.
  const periodOrigin = usePeriodOrigin();
  const periodNotice = periodOrigin !== null && (
    <PeriodOriginNotice origin={periodOrigin} />
  );

  if (invoicesQ.isError && invoicesQ.data === undefined) {
    return (
      <div className="mx-auto max-w-3xl">
        <ScreenHeader
          title="Invoice"
          heading="Invoice"
          backTo="/books?seg=invoices"
        />
        {periodNotice}
        <LoadError
          message={
            invoicesQ.error instanceof Error
              ? invoicesQ.error.message
              : 'Failed to load invoices'
          }
          onRetry={() => void invoicesQ.refetch()}
        />
      </div>
    );
  }
  if (invoicesQ.isPending) {
    return (
      <div className="mx-auto max-w-3xl">
        <ScreenHeader
          title="Invoice"
          heading="Invoice"
          backTo="/books?seg=invoices"
        />
        <SkeletonRows count={4} />
      </div>
    );
  }
  if (inv === undefined) {
    return (
      <div className="mx-auto max-w-3xl">
        <ScreenHeader
          title="Invoice"
          heading="Invoice"
          backTo="/books?seg=invoices"
        />
        {periodNotice}
        <EmptyState
          icon="🤷"
          title="This invoice is not in the books"
          hint="It may have been deleted."
        />
      </div>
    );
  }

  const customer = entityName(entitiesQ.data ?? [], inv.customer_id);
  const rate = vatRatePct(inv.gross_amount, inv.vat_amount);
  const rejection = rejectionQ.data ?? null;

  const onSubmitForPosting = () => {
    const { id, gross_amount } = inv;
    // Only the post's own failure is "not confirmed" — a failed refresh
    // after an accepted post keeps its recorded outcome.
    let accepted = false;
    op.run(
      async (ctx) => {
        const res = await postInvoice(id);
        accepted = true;
        ctx.check();
        // Recorded before the cache refresh: the post is accepted (#259).
        const held = res.policy.action === 'hold-for-approval';
        receipt(
          `post:${id}`,
          {
            action: 'Submit for posting',
            title: `Invoice ${inv.invoice_number}`,
            outcome: held
              ? `Held for approval — ${humanizePolicyReason(res.policy.reason)}. Not posted until approved.`
              : `Posted · ${signedEuros(gross_amount)}`,
            tone: held ? 'pending' : 'ok',
            links: [
              {
                label: `Invoice ${inv.invoice_number}`,
                to: `/books/invoices/${id}`,
              },
            ],
          },
          ctx.live,
        );
        await invalidateBooks(qc);
        return res;
      },
      {
        onSuccess: (res) => {
          if (res.policy.action === 'hold-for-approval') {
            toastOk(
              `Held for approval — ${humanizePolicyReason(res.policy.reason)}`,
            );
          } else {
            toastOk(`Posted · ${signedEuros(gross_amount)}`);
          }
        },
        onError: (e) => {
          toastErr(errorMessage(e));
          if (accepted) return;
          receipt(`post:${id}`, {
            action: 'Submit for posting',
            title: `Invoice ${inv.invoice_number}`,
            outcome: `Submitting for posting was not confirmed (${errorMessage(e)}). Open it for its current state before trying again.`,
            tone: 'error',
            links: [
              {
                label: `Invoice ${inv.invoice_number}`,
                to: `/books/invoices/${id}`,
              },
            ],
          });
        },
      },
    );
  };

  const onDelete = () => {
    const { id } = inv;
    op.run(
      async (ctx) => {
        await deleteInvoice(id);
        ctx.check();
        await invalidateBooks(qc);
      },
      {
        onSuccess: () => {
          toastOk('Draft invoice deleted');
          setConfirmDelete(false);
          if (periodOrigin !== null) periodOrigin.returnTo();
          else navigate('/books?seg=invoices', { replace: true });
        },
        onError: (e) => {
          toastErr(e instanceof Error ? e.message : String(e));
          setConfirmDelete(false);
        },
      },
    );
  };

  return (
    <div className="mx-auto max-w-3xl pb-6">
      <ScreenHeader
        title="Invoice"
        heading={`Invoice ${inv.invoice_number}`}
        backTo="/books?seg=invoices"
      />
      {periodNotice}
      <RefetchError query={invoicesQ} />

      <div className="px-5 pb-4 pt-1 text-center">
        <AmountText
          cents={inv.gross_amount}
          currency={inv.currency}
          showSign
          className="text-[30px]"
        />
        <p className="mt-1 text-[14px] text-ink-2">
          {customer != null
            ? `${customer} · ${inv.invoice_number}`
            : inv.invoice_number}{' '}
          <span className="align-[2px]">{statusChip(inv.status)}</span>
        </p>
      </div>

      {inv.status === 'draft' && rejection != null && (
        <div className="mx-3.5 mb-3.5 rounded-2xl bg-warn-bg px-4 py-3">
          <p className="text-[13px] font-semibold text-warn">
            Rejected — {rejection.rejected_reason ?? 'no reason recorded'}
          </p>
          <p className="mt-0.5 text-[12px] text-ink-2">
            Fix what is wrong, then submit for posting again.
          </p>
        </div>
      )}

      <ListGroup label="Facts">
        <KeyValue k="Invoice no." v={inv.invoice_number} />
        <KeyValue
          k="VAT"
          v={`${fmtCents(inv.vat_amount)} €${rate != null ? ` (${rate}%)` : ''}`}
        />
        <KeyValue k="Tax point" v={absoluteDateFromIso(inv.tax_point_date)} />
        {inv.due_date != null && (
          <KeyValue k="Due" v={absoluteDateFromIso(inv.due_date)} />
        )}
        {customer != null && <KeyValue k="Customer" v={customer} />}
        {inv.sent_at != null && (
          <KeyValue k="Sent" v={absoluteDate(inv.sent_at)} />
        )}
        <KeyValue
          k="Bank"
          v={inv.reconciled ? '🏦 Reconciled' : 'Not matched'}
        />
      </ListGroup>

      {inv.document_id != null && (
        <ListGroup label="Document">
          <ListRow
            to={`/books/documents/${inv.document_id}`}
            leading={<span aria-hidden>📄</span>}
            title="Source document"
            subtitle="Open the document detail"
          />
        </ListGroup>
      )}

      {(inv.status === 'reversed' ||
        (inv.status === 'draft' && rejection != null)) && (
        <ListGroup label="History">
          {inv.status === 'reversed' && (
            <ListRow
              title="Corrected"
              subtitle="The original entry was reversed and replaced; the figures above are the corrected ones"
            />
          )}
          {inv.status === 'draft' && rejection != null && (
            <ListRow
              title="Rejected — returned to draft"
              subtitle={
                rejection.resolved_at != null
                  ? `See the rejection notice above · ${absoluteDate(rejection.resolved_at)}`
                  : 'See the rejection notice above'
              }
            />
          )}
        </ListGroup>
      )}

      <div className="space-y-2 px-5 pt-2">
        {inv.status === 'draft' && (
          <>
            <Button className="w-full" busy={busy} onClick={onSubmitForPosting}>
              Submit for posting
            </Button>
            <Button
              variant="secondary"
              className="w-full"
              disabled={busy}
              onClick={() => editSheet.open()}
            >
              Edit draft…
            </Button>
            <Button
              variant="danger"
              className="w-full"
              disabled={busy}
              onClick={() => setConfirmDelete(true)}
            >
              Delete draft…
            </Button>
          </>
        )}
        {inv.status === 'pending' && (
          <PendingApproval
            objectType="sales_invoice"
            objectId={inv.id}
            noun="invoice"
            onReload={() => void invoicesQ.refetch()}
          />
        )}
        {inv.status === 'posted' && (
          <>
            <Button
              variant="secondary"
              className="w-full"
              onClick={() => correctSheet.open()}
            >
              Correct…
            </Button>
            <LinkButton
              to={`/books/credit-notes/new?type=sales_invoice&id=${inv.id}`}
              variant="secondary"
              className="w-full"
            >
              Issue credit note…
            </LinkButton>
            <p className="text-center text-[12.5px] text-ink-2">
              A posted invoice can’t be edited — change it with a correction or
              a credit note.
            </p>
          </>
        )}
        {inv.status === 'reversed' && (
          <p
            ref={correctedRef}
            tabIndex={-1}
            className="text-center text-[12.5px] text-ink-2"
          >
            Already corrected — a posted invoice can be corrected only once.
          </p>
        )}
      </div>

      {/* Mount is reachable independent of `inv.status`: a successful
       *  financial correction flips status posted→reversed via the
       *  invalidate-then-refetch inside CorrectSheet's own submit() BEFORE
       *  it calls onOpenChange(false) — gating the mount on `status ===
       *  'posted'` would unmount the still-closing sheet mid-transition
       *  (aria-hidden race + killed exit animation). The TRIGGER above
       *  stays gated on status; only the mount moved to the sheet's own
       *  open/close lifecycle (epoch keeps state fresh per open, P07 T7
       *  discipline). */}
      {/* Same keep-mounted lifecycle as CorrectSheet: a save refetches the
       *  object while the sheet closes; the epoch key gives every open a
       *  fresh form prefilled from the current facts. */}
      {editSheet.epoch > 0 && (
        <InvoiceEditSheet
          key={`edit-${inv.id}-${editSheet.epoch}`}
          open={editSheet.isOpen}
          onOpenChange={(o) => !o && editSheet.close()}
          invoice={inv}
          onSaved={() => void invoicesQ.refetch()}
        />
      )}

      {correctSheet.epoch > 0 && (
        <CorrectSheet
          key={`${inv.id}-${correctSheet.epoch}`}
          open={correctSheet.isOpen}
          onOpenChange={(o) => !o && correctSheet.close()}
          objectType="sales_invoice"
          objectId={inv.id}
          grossCents={inv.gross_amount}
          vatCents={inv.vat_amount}
          returnFocusFallback={correctedRef}
          onDone={() => void invoicesQ.refetch()}
        />
      )}

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Delete this draft invoice?"
        body="The draft is removed permanently. Posted invoices can never be deleted — only corrected or credited."
        confirmLabel="Delete"
        destructive
        busy={busy}
        onConfirm={onDelete}
      />
    </div>
  );
}
