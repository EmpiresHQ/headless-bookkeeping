import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, RefreshCw, Trash2 } from 'lucide-react';
import {
  completeDocument,
  deleteDocument,
  getDocumentDetails,
  retryDocument,
  type TriageOutcome,
} from '../api';
import { ScreenHeader } from '../shell/Headers';
import { inboxKeys, invalidateInbox, useNeedsTriage } from '../queries/inbox';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { EmptyState, SkeletonRows } from '../ui/Feedback';
import { LinkButton } from '../ui/LinkButton';
import { READABLE } from '../ui/List';
import { LoadError, RefetchError } from '../ui/LoadError';
import { toastErr, toastOk } from '../ui/toast';
import { ClassifyExpenseSheet } from './ClassifyExpenseSheet';
import { ClassifyInvoiceSheet } from './ClassifyInvoiceSheet';
import { DuplicateReviewSheet } from './DuplicateReviewSheet';
import { DocPreviewRow } from './DocPreviewRow';
import { OcrFailedSheet } from './OcrFailedSheet';
import { outcomeText } from './reason';
import { ResolveSupplierSheet } from './ResolveSupplierSheet';
import { TriageDecisionPanel } from './TriageDecisionPanel';
import { TriageDocumentContext } from './TriageDocumentContext';
import { useInboxCompletion } from './useInboxCompletion';
import { usePendingOperation } from '../lib/pendingOperation';
import { useResultLog } from '../lib/resultLog';
import { outcomeLinks } from '../upload/uploadFlow';

type SheetKind = 'resolve' | 'classify' | 'invoice' | 'ocr' | 'duplicate';

/** /inbox/doc/:id — triage detail: persisted facts + the right resolution
 *  flow for the reason (fullscreen sheets), plus Retry AI / Dismiss / Delete.
 *  Facts come from getDocumentDetails ONLY (ADR-0039); the AI re-run happens
 *  inside the classify sheets via the sanctioned reclassify endpoint. */
export function TriageDocScreen() {
  const { id } = useParams();
  const docId = Number(id);
  const route = `/inbox/doc/${docId}`;
  const qc = useQueryClient();

  const triageQ = useNeedsTriage();
  const item = triageQ.data?.find((i) => i.id === docId);
  const { position, next, leave, context, backHref } =
    useInboxCompletion(route);
  const detailsQ = useQuery({
    queryKey: inboxKeys.docDetails(docId),
    queryFn: () => getDocumentDetails(docId),
  });

  const [sheet, setSheetKind] = useState<SheetKind | null>(null);
  // Remount-on-open (issue #250): every open gets fresh sheet state, so a
  // discarded draft never reappears when the same sheet is reopened.
  const [sheetEpoch, setSheetEpoch] = useState(0);
  const setSheet = (kind: SheetKind | null) => {
    if (kind !== null) setSheetEpoch((e) => e + 1);
    setSheetKind(kind);
  };
  // A sheet belongs to its document: Back/forward to another doc re-renders
  // this same element, so close it instead of reopening over doc N±1.
  const [sheetDoc, setSheetDoc] = useState(docId);
  if (sheetDoc !== docId) {
    setSheetDoc(docId);
    setSheetKind(null);
  }
  const [confirm, setConfirm] = useState<'dismiss' | 'delete' | null>(null);
  const op = usePendingOperation('Document triage');
  const log = useResultLog();
  const busy = op.pending;
  // Remount nonce for the sheets: bumped when an unknown outcome keeps the
  // operator on the SAME document (same docId → same key otherwise), so
  // reopening the sheet to retry gets a fresh instance instead of the one
  // whose success path deliberately left busy=true.
  const [attempt, setAttempt] = useState(0);

  // Synchronous continuations (issue #251): they run from an operation's
  // live-scope success; the queue refresh is started, not awaited.
  const finishTriage = (o: TriageOutcome) => {
    setSheet(null);
    if (o.kind === 'unknown') {
      // Still unresolved — stay here, refresh the reason.
      setAttempt((a) => a + 1);
      toastErr(outcomeText(o));
      void invalidateInbox(qc);
      return;
    }
    toastOk(outcomeText(o));
    // Durable (#259): which object the document became, after the screen
    // has moved on to the next item.
    log.record({
      action: 'Triage',
      title: `Document #${o.document_id}`,
      outcome: outcomeText(o),
      tone: 'ok',
      links: outcomeLinks(o),
    });
    leave(next);
    void invalidateInbox(qc);
  };

  const advance = (message: string, deleted = false) => {
    toastOk(message);
    // Auto-advance re-renders this SAME element for the next document
    // (only the :id param changes) — reset the screen-level action state
    // BEFORE navigating, or doc N+1 renders with the confirm dialog still
    // open, or (OcrFailedSheet.onRetried) a Fix-file sheet auto-opened over
    // the WRONG document — its Upload replacement would then archive the
    // next doc's original file.
    setSheet(null);
    setConfirm(null);
    // Navigate BEFORE the invalidation settles: awaiting it first let the
    // refetch land, the item vanish, and the "Already handled" empty
    // state flash for a frame (P03 Task 13 deferred item). A deleted file
    // takes its Books page with it: an origin showing it is not returned to.
    leave(
      next,
      deleted
        ? { path: `/books/documents/${docId}`, to: '/books?seg=documents' }
        : undefined,
    );
    void invalidateInbox(qc);
  };

  const runAction = (
    fn: () => Promise<unknown>,
    message: string,
    deleted = false,
  ) => {
    op.run(fn, {
      onSuccess: () => advance(message, deleted),
      onError: (e) => {
        toastErr(e instanceof Error ? e.message : String(e));
        setConfirm(null);
      },
    });
  };

  const title =
    position !== null ? `${position.pos} of ${position.total}` : 'Document';

  if (triageQ.isPending) {
    return (
      <div className="mx-auto max-w-3xl pb-6">
        <ScreenHeader title="Document" backTo={backHref} />
        <SkeletonRows count={3} />
      </div>
    );
  }
  if (triageQ.isError && triageQ.data === undefined) {
    return (
      <div className="mx-auto max-w-3xl pb-6">
        <ScreenHeader title="Document" backTo={backHref} />
        <LoadError
          message={
            triageQ.error instanceof Error
              ? triageQ.error.message
              : 'Failed to load the queue'
          }
          onRetry={() => void triageQ.refetch()}
        />
      </div>
    );
  }
  if (item === undefined) {
    return (
      <div className="mx-auto max-w-3xl pb-6">
        <ScreenHeader title="Document" backTo={backHref} />
        <EmptyState
          icon="✓"
          title="Already handled"
          hint="This document is no longer waiting for triage."
          action={<LinkButton to={backHref}>Back to Inbox</LinkButton>}
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl pb-6">
      <ScreenHeader title={title} backTo={backHref} />
      <p className="-mt-1 px-5 pb-1 text-center text-[11.5px] text-ink-2">
        {context}
      </p>
      <RefetchError query={triageQ} />
      <div className="px-5 pb-2 pt-1 text-center">
        <p className={`text-[17px] font-extrabold ${READABLE}`}>
          {item.filename}
        </p>
      </div>
      <TriageDecisionPanel
        documentId={docId}
        item={item}
        op={op}
        onOpen={setSheet}
        onArchive={() => setConfirm('dismiss')}
        onResolved={finishTriage}
      />
      <DocPreviewRow documentId={docId} />
      <TriageDocumentContext details={detailsQ.data} />

      <div className="mx-3.5 mt-3 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 border-t border-line pt-3">
        <button
          type="button"
          disabled={busy}
          className="flex min-h-11 items-center gap-1.5 text-[13px] font-semibold text-accent disabled:opacity-50"
          onClick={() =>
            runAction(
              () => retryDocument(docId),
              'Queued for a fresh AI run — the queue updates as it lands',
            )
          }
        >
          <RefreshCw className="size-4" /> Retry AI
        </button>
        {item.reason_type !== 'not_a_document' && (
          <button
            type="button"
            disabled={busy}
            className="flex min-h-11 items-center gap-1.5 text-[13px] font-semibold text-ink-2 disabled:opacity-50"
            onClick={() => setConfirm('dismiss')}
          >
            <Archive className="size-4" /> Archive without booking
          </button>
        )}
        {item.reason_type === 'not_a_document' && (
          <button
            type="button"
            disabled={busy}
            onClick={() => setConfirm('delete')}
            className="flex min-h-11 items-center gap-1.5 text-[13px] font-semibold text-err disabled:opacity-50"
          >
            <Trash2 className="size-4" /> Delete file
          </button>
        )}
      </div>

      <ConfirmDialog
        open={confirm === 'dismiss'}
        onOpenChange={(o) => {
          if (!o) setConfirm(null);
        }}
        title="Archive without booking?"
        body="It is archived as processed without creating anything. There is no undo."
        confirmLabel="Archive document"
        busy={busy}
        onConfirm={() =>
          runAction(() => completeDocument(docId), 'Archived without booking')
        }
      />
      <ConfirmDialog
        open={confirm === 'delete'}
        onOpenChange={(o) => {
          if (!o) setConfirm(null);
        }}
        title="Delete this file?"
        body="The file is removed entirely. Archive it instead if you need to keep the source."
        confirmLabel="Delete"
        destructive
        busy={busy}
        onConfirm={() =>
          runAction(() => deleteDocument(docId), 'File deleted', true)
        }
      />

      {/* kind-docId-attempt keys: these sheets do NOT self-reset internal
       *  state (prefill flags, typed fields, busy) across documents or after
       *  a successful submit that leaves busy=true for the parent to unmount
       *  (Tasks 10-12). Without the docId in the key, advancing to the next
       *  item would reuse the same component instance and surface the
       *  PREVIOUS document's stale fields / a permanently-busy button; the
       *  attempt nonce covers the unknown-outcome retry on the SAME doc.
       *  Same fix class as the Task 11/12 prefill race — disclosed per the
       *  binding review note for this task. */}
      <ResolveSupplierSheet
        key={`resolve-${docId}-${attempt}-${sheetEpoch}`}
        documentId={docId}
        open={sheet === 'resolve'}
        onOpenChange={(o) => setSheet(o ? 'resolve' : null)}
        onDone={finishTriage}
      />
      <DuplicateReviewSheet
        key={`duplicate-${docId}-${attempt}-${sheetEpoch}`}
        documentId={docId}
        reason={item.reason}
        open={sheet === 'duplicate'}
        onOpenChange={(o) => setSheet(o ? 'duplicate' : null)}
        onArchive={() => {
          setSheet(null);
          setConfirm('dismiss');
        }}
      />
      <ClassifyExpenseSheet
        key={`classify-${docId}-${attempt}-${sheetEpoch}`}
        documentId={docId}
        open={sheet === 'classify'}
        onOpenChange={(o) => setSheet(o ? 'classify' : null)}
        onDone={finishTriage}
      />
      <ClassifyInvoiceSheet
        key={`invoice-${docId}-${attempt}-${sheetEpoch}`}
        documentId={docId}
        open={sheet === 'invoice'}
        onOpenChange={(o) => setSheet(o ? 'invoice' : null)}
        onDone={finishTriage}
      />
      <OcrFailedSheet
        key={`ocr-${docId}-${attempt}-${sheetEpoch}`}
        documentId={docId}
        open={sheet === 'ocr'}
        onOpenChange={(o) => setSheet(o ? 'ocr' : null)}
        onReplaced={finishTriage}
        onRetried={() =>
          advance('Queued for a fresh AI run — the queue updates as it lands')
        }
      />
    </div>
  );
}
