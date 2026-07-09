import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { deleteInvoice, postInvoice } from '../api';
import { absoluteDate, absoluteDateFromIso, vatRatePct } from '../inbox/format';
import { humanizePolicyReason } from '../inbox/reason';
import {
  entityName,
  invalidateBooks,
  useRejectedReason,
} from '../queries/books';
import { useEntities, useInvoices } from '../queries/shared';
import { ScreenHeader } from '../shell/Headers';
import { AmountText } from '../ui/AmountText';
import { Button } from '../ui/Button';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { EmptyState, SkeletonRows } from '../ui/Feedback';
import { LinkButton } from '../ui/LinkButton';
import { KeyValue, ListGroup, ListRow } from '../ui/List';
import { LoadError } from '../ui/LoadError';
import { toastErr, toastOk } from '../ui/toast';
import { statusChip } from './chips';
import { CorrectSheet } from './CorrectSheet';

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

  const [correctOpen, setCorrectOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);

  if (invoicesQ.isError) {
    return (
      <div className="mx-auto max-w-3xl">
        <ScreenHeader title="Invoice" backTo="/books?seg=invoices" />
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
        <ScreenHeader title="Invoice" backTo="/books?seg=invoices" />
        <SkeletonRows count={4} />
      </div>
    );
  }
  if (inv === undefined) {
    return (
      <div className="mx-auto max-w-3xl">
        <ScreenHeader title="Invoice" backTo="/books?seg=invoices" />
        <EmptyState
          icon="🤷"
          title="This invoice is not in the books"
          hint="It may have been deleted. (The API has no single-invoice lookup.)"
        />
      </div>
    );
  }

  const customer = entityName(entitiesQ.data ?? [], inv.customer_id);
  const rate = vatRatePct(inv.gross_amount, inv.vat_amount);
  const rejection = rejectionQ.data ?? null;

  const onSubmitForPosting = async () => {
    setBusy(true);
    try {
      const res = await postInvoice(inv.id);
      await invalidateBooks(qc);
      if (res.policy.action === 'hold-for-approval') {
        toastOk(
          `Held for approval — ${humanizePolicyReason(res.policy.reason)}`,
        );
      } else {
        toastOk(`Posted · +${(inv.gross_amount / 100).toFixed(2)} €`);
      }
    } catch (e) {
      toastErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onDelete = async () => {
    setBusy(true);
    try {
      await deleteInvoice(inv.id);
      await invalidateBooks(qc);
      toastOk('Draft invoice deleted');
      navigate('/books?seg=invoices', { replace: true });
    } catch (e) {
      toastErr(e instanceof Error ? e.message : String(e));
      setConfirmDelete(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl pb-6">
      <ScreenHeader title="Invoice" backTo="/books?seg=invoices" />

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
          v={`${(inv.vat_amount / 100).toFixed(2)} €${rate != null ? ` (${rate}%)` : ''}`}
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
              subtitle="A reversal + corrected entry replaced the original (ADR-0009)"
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
            <Button
              className="w-full"
              busy={busy}
              onClick={() => void onSubmitForPosting()}
            >
              Submit for posting
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
          <>
            <p className="text-center text-[12.5px] text-ink-2">
              Waiting for approval — decide it in the Inbox.
            </p>
            <LinkButton to="/inbox?seg=approvals" className="w-full">
              Open Inbox
            </LinkButton>
          </>
        )}
        {inv.status === 'posted' && (
          <>
            <Button
              variant="secondary"
              className="w-full"
              onClick={() => setCorrectOpen(true)}
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
              Posted entries change only through a correction (ADR-0009).
            </p>
          </>
        )}
        {inv.status === 'reversed' && (
          <p className="text-center text-[12.5px] text-ink-2">
            Already corrected — corrections are one-shot (ADR-0009).
          </p>
        )}
      </div>

      {inv.status === 'posted' && (
        <CorrectSheet
          key={inv.id}
          open={correctOpen}
          onOpenChange={setCorrectOpen}
          objectType="sales_invoice"
          objectId={inv.id}
          grossCents={inv.gross_amount}
          vatCents={inv.vat_amount}
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
        onConfirm={() => void onDelete()}
      />
    </div>
  );
}
