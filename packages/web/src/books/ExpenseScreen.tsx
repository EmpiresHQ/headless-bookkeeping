import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  deleteExpense,
  fmtCents,
  postExpense,
  type ExpenseDetail,
} from '../api';
import { absoluteDate, absoluteDateFromIso, vatRatePct } from '../inbox/format';
import { humanizePolicyReason } from '../inbox/reason';
import { currencyMark, signedMoney } from '../lib/money';
import { errorMessage, usePendingOperation } from '../lib/pendingOperation';
import { useReceipt } from '../lib/resultLog';
import { useSheet } from '../lib/useSheet';
import {
  entityName,
  invalidateBooks,
  useDocumentsArchive,
  useExpenseFacts,
  useRejectedReason,
} from '../queries/books';
import { useEntities, useExpenses } from '../queries/shared';
import { PeriodOriginNotice, usePeriodOrigin } from '../reports/PeriodOrigin';
import { ScreenHeader } from '../shell/Headers';
import { AmountText } from '../ui/AmountText';
import { Button } from '../ui/Button';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { SkeletonRows } from '../ui/Feedback';
import { KeyValue, ListGroup, ListRow } from '../ui/List';
import { LoadError, RefetchError } from '../ui/LoadError';
import { toastErr, toastOk } from '../ui/toast';
import { statusChip } from './chips';
import { CorrectSheet } from './CorrectSheet';
import { ExpenseEditSheet } from './EditDraftSheet';
import { AttachDocumentSheet } from './AttachDocumentSheet';
import { PendingApproval } from './PendingApproval';
import { useScreenEntry } from '../lib/screenEntry';

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
          subtitle="The original entry was reversed and replaced; the figures above are the corrected ones"
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
  useScreenEntry(detail !== undefined || detailQ.isError);
  const rejectionQ = useRejectedReason(
    'expense',
    id,
    detail?.status === 'draft',
  );

  const [confirmDelete, setConfirmDelete] = useState(false);
  const correctSheet = useSheet();
  // Return target once a correction removed "Correct…" (issue #268).
  const correctedRef = useRef<HTMLParagraphElement>(null);
  const editSheet = useSheet();
  const attachSheet = useSheet();
  const op = usePendingOperation('Expense');
  const receipt = useReceipt();
  const busy = op.pending;
  // Opened from a period drill-down list (issue #261): say so, offer the
  // way back, and return there after a delete instead of global Books.
  const periodOrigin = usePeriodOrigin();
  const periodNotice = periodOrigin !== null && (
    <PeriodOriginNotice origin={periodOrigin} />
  );

  if (detailQ.isError && detailQ.data === undefined) {
    return (
      <div className="mx-auto max-w-3xl">
        <ScreenHeader title="Expense" heading="Expense" backTo="/books" />
        {periodNotice}
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
        <ScreenHeader title="Expense" heading="Expense" backTo="/books" />
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

  const onSubmitForPosting = () => {
    const { id, gross_amount, currency } = detail;
    // Only the post's own failure is "not confirmed" — a failed refresh
    // after an accepted post keeps its recorded outcome.
    let accepted = false;
    op.run(
      async (ctx) => {
        const res = await postExpense(id);
        accepted = true;
        ctx.check();
        // Recorded before the cache refresh: the post is accepted (#259).
        const held = res.policy.action === 'hold-for-approval';
        receipt(
          `post:${id}`,
          {
            action: 'Submit for posting',
            title: `Expense #${id}`,
            outcome: held
              ? `Held for approval — ${humanizePolicyReason(res.policy.reason)}. Not posted until approved.`
              : `Posted · ${signedMoney(-gross_amount, currency)}`,
            tone: held ? 'pending' : 'ok',
            links: [{ label: `Expense #${id}`, to: `/books/expenses/${id}` }],
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
            toastOk(`Posted · ${signedMoney(-gross_amount, currency)}`);
          }
        },
        onError: (e) => {
          toastErr(errorMessage(e));
          if (accepted) return;
          receipt(`post:${id}`, {
            action: 'Submit for posting',
            title: `Expense #${id}`,
            outcome: `Submitting for posting was not confirmed (${errorMessage(e)}). Open it for its current state before trying again.`,
            tone: 'error',
            links: [{ label: `Expense #${id}`, to: `/books/expenses/${id}` }],
          });
        },
      },
    );
  };

  const onDelete = () => {
    const { id } = detail;
    op.run(
      async (ctx) => {
        await deleteExpense(id);
        ctx.check();
        await invalidateBooks(qc);
      },
      {
        onSuccess: () => {
          toastOk('Draft expense deleted');
          setConfirmDelete(false);
          if (periodOrigin !== null) periodOrigin.returnTo();
          else navigate('/books', { replace: true });
        },
        onError: (e) => {
          // 409 carries the server's own explanation (non-draft).
          toastErr(e instanceof Error ? e.message : String(e));
          setConfirmDelete(false);
        },
      },
    );
  };

  return (
    <div className="mx-auto max-w-3xl pb-6">
      <ScreenHeader
        title="Expense"
        heading={`Expense #${detail.id}${supplier != null ? `, ${supplier}` : ''}`}
        backTo="/books"
      />
      {periodNotice}
      <RefetchError query={detailQ} />

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
          v={`${fmtCents(detail.vat_amount)} ${currencyMark(detail.currency)}${rate != null ? ` (${rate}%)` : ''}`}
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
            leading={<span aria-hidden>📎</span>}
            title="Attach receipt…"
            subtitle="No source document yet — upload it or pick one from Documents"
            onClick={() => attachSheet.open()}
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
        {detail.status === 'pending' && (
          <PendingApproval
            objectType="expense"
            objectId={detail.id}
            noun="expense"
            onReload={() => void detailQ.refetch()}
          />
        )}
        {detail.status === 'posted' && (
          <>
            <Button
              variant="secondary"
              className="w-full"
              onClick={() => correctSheet.open()}
            >
              Correct…
            </Button>
            <p className="text-center text-[12.5px] text-ink-2">
              A posted expense can’t be edited — change it with a correction.
            </p>
          </>
        )}
        {detail.status === 'reversed' && (
          <p
            ref={correctedRef}
            tabIndex={-1}
            className="text-center text-[12.5px] text-ink-2"
          >
            Already corrected — a posted expense can be corrected only once. For
            further changes, ask your bookkeeper.
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
        onConfirm={onDelete}
      />

      {/* Mount is reachable independent of `detail.status`: a successful
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
        <ExpenseEditSheet
          key={`edit-${detail.id}-${editSheet.epoch}`}
          open={editSheet.isOpen}
          onOpenChange={(o) => !o && editSheet.close()}
          detail={detail}
          onSaved={() => void detailQ.refetch()}
        />
      )}

      {/* Same keep-mounted lifecycle: a successful attach refetches the
       *  expense (its Document group flips to the linked file) while the
       *  sheet closes. */}
      {attachSheet.epoch > 0 && (
        <AttachDocumentSheet
          key={`attach-${detail.id}-${attachSheet.epoch}`}
          open={attachSheet.isOpen}
          onOpenChange={(o) => !o && attachSheet.close()}
          detail={detail}
        />
      )}

      {correctSheet.epoch > 0 && (
        <CorrectSheet
          key={`${detail.id}-${correctSheet.epoch}`}
          open={correctSheet.isOpen}
          onOpenChange={(o) => !o && correctSheet.close()}
          objectType="expense"
          objectId={detail.id}
          grossCents={detail.gross_amount}
          vatCents={detail.vat_amount}
          category={detail.category}
          returnFocusFallback={correctedRef}
          onDone={() => void detailQ.refetch()}
        />
      )}
    </div>
  );
}
