import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  copyDocumentShareLink,
  deleteDocument,
  fmtCents,
  retryDocument,
  type DocumentDetails,
} from '../api';
import { DocPreviewRow } from '../inbox/DocPreviewRow';
import { absoluteDate, absoluteDateFromIso } from '../inbox/format';
import { triageSubtitle } from '../inbox/reason';
import {
  invalidateBooks,
  useDocDetails,
  useDocumentsArchive,
} from '../queries/books';
import { ScreenHeader } from '../shell/Headers';
import { Button } from '../ui/Button';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { EmptyState, SkeletonRows } from '../ui/Feedback';
import { LinkButton } from '../ui/LinkButton';
import { KeyValue, ListGroup, ListRow } from '../ui/List';
import { LoadError } from '../ui/LoadError';
import { toastErr, toastOk } from '../ui/toast';
import { channelLabel } from './DocumentsSegment';
import { statusChip } from './chips';

function ClassificationFacts({ details }: { details: DocumentDetails }) {
  if (details.classification === null) {
    return (
      <p className="px-3.5 py-2.5 text-[13px] text-ink-2">
        No classification — OCR produced no text.
      </p>
    );
  }
  if (!details.classification.ok) {
    return (
      <p className="px-3.5 py-2.5 text-[13px] text-err">
        Classification failed ({details.classification.category}):{' '}
        {details.classification.detail}
      </p>
    );
  }
  const r = details.classification.result;
  return (
    <>
      <KeyValue k="Recognized as" v={r.document_type} />
      <KeyValue k="Category" v={r.category} />
      <KeyValue
        k="Amount"
        v={`${fmtCents(r.gross_amount)} € (VAT ${fmtCents(r.vat_amount)} €)`}
      />
      <KeyValue k="Tax point" v={absoluteDateFromIso(r.tax_point_date)} />
      {r.supplier_invoice_number != null && (
        <KeyValue k="Invoice no." v={r.supplier_invoice_number} />
      )}
      <KeyValue k="AI confidence" v={r.confidence.toFixed(2)} />
    </>
  );
}

/** /books/documents/:id — everything rendered from PERSISTED intake
 *  artifacts (ADR-0039); AI re-runs only via the explicit Retry. */
export function DocumentScreen() {
  const { id: idParam } = useParams();
  const id = Number(idParam);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const docsQ = useDocumentsArchive();
  const detailsQ = useDocDetails(id);

  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);

  if (docsQ.isError) {
    return (
      <div className="mx-auto max-w-3xl">
        <ScreenHeader title="Document" backTo="/books?seg=documents" />
        <LoadError
          message={
            docsQ.error instanceof Error
              ? docsQ.error.message
              : 'Failed to load documents'
          }
          onRetry={() => void docsQ.refetch()}
        />
      </div>
    );
  }
  if (docsQ.isPending) {
    return (
      <div className="mx-auto max-w-3xl">
        <ScreenHeader title="Document" backTo="/books?seg=documents" />
        <SkeletonRows count={4} />
      </div>
    );
  }
  const doc = (docsQ.data ?? []).find((d) => d.id === id);
  if (doc === undefined) {
    return (
      <div className="mx-auto max-w-3xl">
        <ScreenHeader title="Document" backTo="/books?seg=documents" />
        <EmptyState
          icon="🤷"
          title="Document not found"
          hint="It may have been deleted."
        />
      </div>
    );
  }

  // Server guard mirror (Reality #8, ADR-0012): the document is evidence.
  const deleteLocked =
    doc.expense_status === 'posted' || doc.expense_status === 'reversed';

  const onCopyLink = async () => {
    try {
      await copyDocumentShareLink(doc.id);
      toastOk('Link copied — valid ~1 hour');
    } catch (e) {
      toastErr(e instanceof Error ? e.message : String(e));
    }
  };

  const onRetry = async () => {
    setBusy(true);
    try {
      await retryDocument(doc.id);
      await invalidateBooks(qc);
      toastOk('Queued for a fresh AI run — the outcome lands in the Inbox');
    } catch (e) {
      toastErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onDelete = async () => {
    setBusy(true);
    try {
      await deleteDocument(doc.id);
      await invalidateBooks(qc);
      toastOk('Document deleted');
      navigate('/books?seg=documents', { replace: true });
    } catch (e) {
      toastErr(e instanceof Error ? e.message : String(e)); // 409 text verbatim
      setConfirmDelete(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl pb-6">
      <ScreenHeader title="Document" backTo="/books?seg=documents" />

      <DocPreviewRow documentId={doc.id} />

      <div className="flex gap-2 px-5 pb-3">
        <Button
          variant="secondary"
          className="flex-1"
          onClick={() => void onCopyLink()}
        >
          Copy link
        </Button>
        {doc.status === 'needs_triage' && (
          <Button
            variant="secondary"
            className="flex-1"
            busy={busy}
            onClick={() => void onRetry()}
          >
            Retry AI
          </Button>
        )}
      </div>

      {doc.status === 'needs_triage' && (
        <div className="mx-3.5 mb-3.5 rounded-2xl bg-warn-bg px-4 py-3">
          <p className="text-[13px] font-semibold text-warn">
            {triageSubtitle({
              reason: doc.reason ?? '',
              reason_type: doc.reason_type ?? 'unknown',
            })}
          </p>
          <LinkButton to={`/inbox/doc/${doc.id}`} className="mt-2 w-full">
            Resolve in Inbox
          </LinkButton>
        </div>
      )}

      <ListGroup label="Facts">
        <KeyValue k="Filename" v={doc.filename} />
        <KeyValue k="Channel" v={channelLabel(doc.channel)} />
        <KeyValue k="Added" v={absoluteDate(doc.created_at)} />
        <KeyValue
          k="Size"
          v={`${Math.max(1, Math.round(doc.size_bytes / 1024))} KB`}
        />
        {doc.claimant_name != null && (
          <KeyValue k="Paid by" v={doc.claimant_name} />
        )}
      </ListGroup>

      {doc.expense_id != null && (
        <ListGroup label="Created from this document">
          <ListRow
            to={`/books/expenses/${doc.expense_id}`}
            leading={<span aria-hidden>🧾</span>}
            title={doc.supplier_name ?? 'Expense'}
            subtitle="Open the expense"
            trailing={
              doc.expense_status != null
                ? statusChip(doc.expense_status)
                : undefined
            }
          />
        </ListGroup>
      )}

      <ListGroup label="AI reading (persisted — never re-run here)">
        {detailsQ.isPending && (
          <p className="px-3.5 py-2.5 text-[13px] text-ink-2">Loading…</p>
        )}
        {detailsQ.isError && (
          <p className="px-3.5 py-2.5 text-[13px] text-err">
            {detailsQ.error instanceof Error
              ? detailsQ.error.message
              : 'Failed to load details'}
          </p>
        )}
        {detailsQ.data !== undefined && (
          <>
            <ClassificationFacts details={detailsQ.data} />
            <details className="border-t border-line px-3.5 py-2.5">
              <summary className="cursor-pointer text-[13px] font-semibold">
                OCR text
              </summary>
              {detailsQ.data.ocr.ok ? (
                <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap text-xs">
                  {detailsQ.data.ocr.markdown}
                </pre>
              ) : (
                <p className="mt-2 text-[13px] text-err">
                  OCR failed ({detailsQ.data.ocr.category}):{' '}
                  {detailsQ.data.ocr.detail}
                </p>
              )}
            </details>
          </>
        )}
      </ListGroup>

      <div className="space-y-2 px-5 pt-2">
        {deleteLocked ? (
          <p className="text-center text-[12.5px] text-ink-2">
            This document is evidence for a posted expense — correct or reverse
            the expense first (ADR-0012).
          </p>
        ) : (
          <Button
            variant="danger"
            className="w-full"
            disabled={busy}
            onClick={() => setConfirmDelete(true)}
          >
            Delete document…
          </Button>
        )}
      </div>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Delete this document?"
        body="The file and its AI reading are removed permanently. Chat threads that delivered it keep their history."
        confirmLabel="Delete"
        destructive
        busy={busy}
        onConfirm={() => void onDelete()}
      />
    </div>
  );
}
