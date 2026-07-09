import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { deleteExpense, postExpense, type ExpenseDetail } from '../api';
import { absoluteDate, absoluteDateFromIso, vatRatePct } from '../inbox/format';
import { humanizePolicyReason } from '../inbox/reason';
import {
  entityName,
  invalidateBooks,
  useDocumentsArchive,
  useExpenseFacts,
  useRejectedReason,
} from '../queries/books';
import { useEntities, useExpenses } from '../queries/shared';
import { ScreenHeader } from '../shell/Headers';
import { AmountText } from '../ui/AmountText';
import { Button } from '../ui/Button';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { SkeletonRows } from '../ui/Feedback';
import { LinkButton } from '../ui/LinkButton';
import { KeyValue, ListGroup, ListRow } from '../ui/List';
import { LoadError } from '../ui/LoadError';
import { toastErr, toastOk } from '../ui/toast';
import { statusChip } from './chips';
import { CorrectSheet } from './CorrectSheet';

/** Honest history (Reality #2): built ONLY from exposed facts — created_at,
 *  the rejection log, and the reversed status. The correction's own date and
 *  reason are voucher-level and not retrievable (Appendix A gap 1). */
function History({
  detail,
  rejectedReason,
  rejectedAt,
}: {
  detail: ExpenseDetail;
  rejectedReason: string | null;
  rejectedAt: number | null;
}) {
  return (
    <ListGroup label="History">
      {detail.status === 'reversed' && (
        <ListRow
          title="Corrected"
          subtitle="A reversal + corrected entry replaced the original (ADR-0009); the figures above are the corrected ones"
        />
      )}
      {rejectedReason != null && (
        <ListRow
          title="Rejected — returned to draft"
          subtitle={
            rejectedAt != null
              ? `See the rejection notice above · ${absoluteDate(rejectedAt)}`
              : 'See the rejection notice above'
          }
        />
      )}
      <ListRow
        title={
          detail.document_id != null ? 'Created from a document' : 'Created'
        }
        subtitle={absoluteDate(detail.created_at)}
      />
    </ListGroup>
  );
}

export function ExpenseScreen() {
  const { id: idParam } = useParams();
  const id = Number(idParam);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const detailQ = useExpenseFacts(id);
  const listQ = useExpenses();
  const entitiesQ = useEntities();
  const docsQ = useDocumentsArchive();
  const detail = detailQ.data;
  const rejectionQ = useRejectedReason(
    'expense',
    id,
    detail?.status === 'draft',
  );

  const [confirmDelete, setConfirmDelete] = useState(false);
  const [correctOpen, setCorrectOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  if (detailQ.isError) {
    return (
      <div className="mx-auto max-w-3xl">
        <ScreenHeader title="Expense" backTo="/books" />
        <LoadError
          message={
            detailQ.error instanceof Error
              ? detailQ.error.message
              : 'Failed to load the expense'
          }
          onRetry={() => void detailQ.refetch()}
        />
      </div>
    );
  }
  if (detail === undefined) {
    return (
      <div className="mx-auto max-w-3xl">
        <ScreenHeader title="Expense" backTo="/books" />
        <SkeletonRows count={4} />
      </div>
    );
  }

  const supplier = entityName(entitiesQ.data ?? [], detail.supplier_id);
  const claimant = entityName(entitiesQ.data ?? [], detail.claimant_id);
  const listRow = (listQ.data ?? []).find((e) => e.id === detail.id);
  const doc = (docsQ.data ?? []).find((d) => d.id === detail.document_id);
  const rate = vatRatePct(detail.gross_amount, detail.vat_amount);
  const rejection = rejectionQ.data ?? null;

  const onSubmitForPosting = async () => {
    setBusy(true);
    try {
      const res = await postExpense(detail.id);
      await invalidateBooks(qc);
      if (res.policy.action === 'hold-for-approval') {
        toastOk(
          `Held for approval — ${humanizePolicyReason(res.policy.reason)}`,
        );
      } else {
        toastOk(`Posted · −${(detail.gross_amount / 100).toFixed(2)} €`);
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
      await deleteExpense(detail.id);
      await invalidateBooks(qc);
      toastOk('Draft expense deleted');
      navigate('/books', { replace: true });
    } catch (e) {
      // 409 carries the server's own explanation (non-draft).
      toastErr(e instanceof Error ? e.message : String(e));
      setConfirmDelete(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl pb-6">
      <ScreenHeader title="Expense" backTo="/books" />

      <div className="px-5 pb-4 pt-1 text-center">
        <AmountText
          cents={-detail.gross_amount}
          currency={detail.currency}
          className="text-[30px]"
        />
        <p className="mt-1 text-[14px] text-ink-2">
          {supplier != null
            ? `${supplier} · ${detail.category}`
            : detail.category}{' '}
          <span className="align-[2px]">{statusChip(detail.status)}</span>
        </p>
      </div>

      {detail.status === 'draft' && rejection != null && (
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
        <KeyValue k="Category" v={detail.category} />
        <KeyValue
          k="VAT"
          v={`${(detail.vat_amount / 100).toFixed(2)} €${rate != null ? ` (${rate}%)` : ''}`}
        />
        <KeyValue
          k="Tax point"
          v={absoluteDateFromIso(detail.tax_point_date)}
        />
        {supplier != null && <KeyValue k="Supplier" v={supplier} />}
        {claimant != null && <KeyValue k="Paid by" v={claimant} />}
        {detail.supplier_invoice_number != null && (
          <KeyValue k="Invoice no." v={detail.supplier_invoice_number} />
        )}
        {detail.ai_confidence != null && (
          <KeyValue k="AI confidence" v={detail.ai_confidence.toFixed(2)} />
        )}
        <KeyValue
          k="Bank"
          v={
            listQ.data === undefined
              ? '—'
              : listRow?.reconciled === true
                ? '🏦 Reconciled'
                : 'Not matched'
          }
        />
      </ListGroup>

      {detail.document_id != null && (
        <ListGroup label="Document">
          <ListRow
            to={`/books/documents/${detail.document_id}`}
            leading={<span aria-hidden>📄</span>}
            title={doc?.filename ?? 'Source document'}
            subtitle="Open the document detail"
          />
        </ListGroup>
      )}
      {detail.document_id == null && (
        <ListGroup label="Document">
          <ListRow
            title="No source document"
            subtitle="Entered without a receipt/invoice — uploads land in Documents (auto-attach is a server follow-up)"
          />
        </ListGroup>
      )}

      <History
        detail={detail}
        rejectedReason={
          detail.status === 'draft'
            ? (rejection?.rejected_reason ?? null)
            : null
        }
        rejectedAt={
          detail.status === 'draft' ? (rejection?.resolved_at ?? null) : null
        }
      />

      <div className="space-y-2 px-5 pt-2">
        {detail.status === 'draft' && (
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
        {detail.status === 'pending' && (
          <>
            <p className="text-center text-[12.5px] text-ink-2">
              Waiting for approval — decide it in the Inbox.
            </p>
            <LinkButton to="/inbox?seg=approvals" className="w-full">
              Open Inbox
            </LinkButton>
          </>
        )}
        {detail.status === 'posted' && (
          <>
            <Button
              variant="secondary"
              className="w-full"
              onClick={() => setCorrectOpen(true)}
            >
              Correct…
            </Button>
            <p className="text-center text-[12.5px] text-ink-2">
              Posted entries change only through a correction (ADR-0009).
            </p>
          </>
        )}
        {detail.status === 'reversed' && (
          <p className="text-center text-[12.5px] text-ink-2">
            Already corrected — corrections are one-shot (ADR-0009). Issue a
            credit note or a new expense for further changes.
          </p>
        )}
      </div>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Delete this draft expense?"
        body="The draft is removed permanently. Posted expenses can never be deleted — only corrected."
        confirmLabel="Delete"
        destructive
        busy={busy}
        onConfirm={() => void onDelete()}
      />

      {detail.status === 'posted' && (
        <CorrectSheet
          key={detail.id}
          open={correctOpen}
          onOpenChange={setCorrectOpen}
          objectType="expense"
          objectId={detail.id}
          grossCents={detail.gross_amount}
          vatCents={detail.vat_amount}
          category={detail.category}
          onDone={() => void detailQ.refetch()}
        />
      )}
    </div>
  );
}
