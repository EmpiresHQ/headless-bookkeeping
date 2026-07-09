import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  completeDocument,
  deleteDocument,
  getDocumentDetails,
  retryDocument,
  type TriageOutcome,
} from '../api';
import { ScreenHeader } from '../shell/Headers';
import {
  inboxKeys,
  invalidateInbox,
  nextRouteAfter,
  queuePosition,
  useInboxQueue,
  useNeedsTriage,
} from '../queries/inbox';
import { Button } from '../ui/Button';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { EmptyState, SkeletonRows } from '../ui/Feedback';
import { KeyValue, ListGroup } from '../ui/List';
import { LinkButton } from '../ui/LinkButton';
import { LoadError } from '../ui/LoadError';
import { toastErr, toastOk } from '../ui/toast';
import { ClassifyExpenseSheet } from './ClassifyExpenseSheet';
import { ClassifyInvoiceSheet } from './ClassifyInvoiceSheet';
import { DocPreviewRow } from './DocPreviewRow';
import { absoluteDateFromIso, signedEuros, vatRatePct } from './format';
import { OcrFailedSheet } from './OcrFailedSheet';
import { outcomeText, triageSubtitle } from './reason';
import { ResolveSupplierSheet } from './ResolveSupplierSheet';

type SheetKind = 'resolve' | 'classify' | 'invoice' | 'ocr';

/** /inbox/doc/:id — triage detail: persisted facts + the right resolution
 *  flow for the reason (fullscreen sheets), plus Retry AI / Dismiss / Delete.
 *  Facts come from getDocumentDetails ONLY (ADR-0039); the AI re-run happens
 *  inside the classify sheets via the sanctioned reclassify endpoint. */
export function TriageDocScreen() {
  const { id } = useParams();
  const docId = Number(id);
  const route = `/inbox/doc/${docId}`;
  const navigate = useNavigate();
  const qc = useQueryClient();

  const triageQ = useNeedsTriage();
  const item = triageQ.data?.find((i) => i.id === docId);
  const { entries } = useInboxQueue('all');
  const position = queuePosition(entries, route);
  const next = nextRouteAfter(entries, route);
  const detailsQ = useQuery({
    queryKey: inboxKeys.docDetails(docId),
    queryFn: () => getDocumentDetails(docId),
  });

  const [sheet, setSheet] = useState<SheetKind | null>(null);
  const [confirm, setConfirm] = useState<'dismiss' | 'delete' | null>(null);
  const [busy, setBusy] = useState(false);
  // Remount nonce for the sheets: bumped when an unknown outcome keeps the
  // operator on the SAME document (same docId → same key otherwise), so
  // reopening the sheet to retry gets a fresh instance instead of the one
  // whose success path deliberately left busy=true.
  const [attempt, setAttempt] = useState(0);

  const finishTriage = async (o: TriageOutcome) => {
    setSheet(null);
    if (o.kind === 'unknown') {
      // Still unresolved — stay here, refresh the reason.
      setAttempt((a) => a + 1);
      toastErr(outcomeText(o));
      await invalidateInbox(qc);
      return;
    }
    toastOk(outcomeText(o));
    await invalidateInbox(qc);
    navigate(next);
  };

  const runAction = async (fn: () => Promise<unknown>, message: string) => {
    setBusy(true);
    try {
      await fn();
      toastOk(message);
      await invalidateInbox(qc);
      // Auto-advance re-renders this SAME element for the next document
      // (only the :id param changes) — reset the screen-level action state
      // BEFORE navigating, or doc N+1 renders with every action disabled
      // and the confirm dialog still open over the wrong document.
      setBusy(false);
      setConfirm(null);
      navigate(next);
    } catch (e) {
      toastErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
      setConfirm(null);
    }
  };

  const title =
    position !== null ? `${position.pos} of ${position.total}` : 'Document';

  if (triageQ.isPending) {
    return (
      <div className="mx-auto max-w-3xl pb-6">
        <ScreenHeader title="Document" backTo="/inbox" />
        <SkeletonRows count={3} />
      </div>
    );
  }
  if (triageQ.isError) {
    return (
      <div className="mx-auto max-w-3xl pb-6">
        <ScreenHeader title="Document" backTo="/inbox" />
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
        <ScreenHeader title="Document" backTo="/inbox" />
        <EmptyState
          icon="✓"
          title="Already handled"
          hint="This document is no longer waiting for triage."
          action={<LinkButton to="/inbox">Back to Inbox</LinkButton>}
        />
      </div>
    );
  }

  const primary = (() => {
    switch (item.reason_type) {
      case 'supplier_unresolved':
        return { label: 'Resolve supplier…', open: 'resolve' as const };
      case 'low_confidence':
      case 'category_unresolved':
        return { label: 'Classify…', open: 'classify' as const };
      case 'outgoing_invoice':
        return { label: 'Record sales invoice…', open: 'invoice' as const };
      case 'ocr_failed':
        return { label: 'Fix file…', open: 'ocr' as const };
      default:
        return null; // Dismiss becomes the primary below
    }
  })();

  const classification = detailsQ.data?.classification;
  const ocr = detailsQ.data?.ocr;

  return (
    <div className="mx-auto max-w-3xl pb-6">
      <ScreenHeader title={title} backTo="/inbox" />
      <div className="px-5 pb-2 pt-1 text-center">
        <p className="truncate text-[17px] font-extrabold">{item.filename}</p>
      </div>
      <div className="mx-3.5 mb-3 rounded-[13px] bg-warn-bg px-3.5 py-2.5">
        <p className="text-[11px] font-bold uppercase tracking-wide text-warn">
          Needs a decision
        </p>
        <p className="text-[12.5px] leading-snug text-warn">
          {triageSubtitle(item)}
        </p>
        {triageSubtitle(item) !== item.reason && (
          <p className="mt-1 text-[11px] leading-snug text-warn opacity-80">
            {item.reason}
          </p>
        )}
      </div>
      <DocPreviewRow documentId={docId} />
      {classification != null && classification.ok && (
        <ListGroup label="AI read (saved at intake)">
          <KeyValue
            k="Amount"
            v={signedEuros(-classification.result.gross_amount)}
          />
          <KeyValue
            k="VAT"
            v={
              vatRatePct(
                classification.result.gross_amount,
                classification.result.vat_amount,
              ) !== null
                ? `${(classification.result.vat_amount / 100).toFixed(2)} € (${vatRatePct(classification.result.gross_amount, classification.result.vat_amount)}%)`
                : `${(classification.result.vat_amount / 100).toFixed(2)} €`
            }
          />
          <KeyValue
            k="Date"
            v={absoluteDateFromIso(classification.result.tax_point_date)}
          />
          <KeyValue k="Category" v={classification.result.category || '—'} />
          <KeyValue
            k="AI confidence"
            v={
              <span
                className={
                  classification.result.confidence >= 0.9
                    ? 'text-ok'
                    : 'text-warn'
                }
              >
                {classification.result.confidence.toFixed(2)}
              </span>
            }
          />
        </ListGroup>
      )}
      {ocr != null && ocr.ok && (
        <details className="mx-3.5 mb-3 rounded-2xl bg-surface px-3.5 py-3">
          <summary className="cursor-pointer text-[13px] font-semibold">
            OCR text
          </summary>
          <pre className="mt-2 max-h-64 overflow-y-auto whitespace-pre-wrap text-[12px] text-ink-2">
            {ocr.markdown}
          </pre>
        </details>
      )}

      <div className="mx-3.5 mt-2 space-y-2.5">
        {primary !== null && (
          <Button
            className="w-full"
            disabled={busy}
            onClick={() => setSheet(primary.open)}
          >
            {primary.label}
          </Button>
        )}
        <div className="flex gap-2.5">
          <Button
            variant="secondary"
            className="flex-1"
            disabled={busy}
            onClick={() =>
              void runAction(
                () => retryDocument(docId),
                'Queued for a fresh AI run — the queue updates as it lands',
              )
            }
          >
            Retry AI
          </Button>
          <Button
            variant={primary === null ? 'primary' : 'secondary'}
            className="flex-1"
            disabled={busy}
            onClick={() => setConfirm('dismiss')}
          >
            Dismiss
          </Button>
        </div>
        {item.reason_type === 'not_a_document' && (
          <button
            type="button"
            disabled={busy}
            onClick={() => setConfirm('delete')}
            className="w-full py-1 text-center text-[13px] font-semibold text-err disabled:opacity-50"
          >
            Delete file…
          </button>
        )}
      </div>

      <ConfirmDialog
        open={confirm === 'dismiss'}
        onOpenChange={(o) => {
          if (!o) setConfirm(null);
        }}
        title="Dismiss this document?"
        body="It is archived as processed without creating anything. There is no undo."
        confirmLabel="Dismiss document"
        busy={busy}
        onConfirm={() =>
          void runAction(
            () => completeDocument(docId),
            'Dismissed — archived without booking',
          )
        }
      />
      <ConfirmDialog
        open={confirm === 'delete'}
        onOpenChange={(o) => {
          if (!o) setConfirm(null);
        }}
        title="Delete this file?"
        body="The file is removed entirely. Use Dismiss instead to keep it in the archive."
        confirmLabel="Delete"
        destructive
        busy={busy}
        onConfirm={() =>
          void runAction(() => deleteDocument(docId), 'File deleted')
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
        key={`resolve-${docId}-${attempt}`}
        documentId={docId}
        open={sheet === 'resolve'}
        onOpenChange={(o) => setSheet(o ? 'resolve' : null)}
        onDone={(o) => void finishTriage(o)}
      />
      <ClassifyExpenseSheet
        key={`classify-${docId}-${attempt}`}
        documentId={docId}
        open={sheet === 'classify'}
        onOpenChange={(o) => setSheet(o ? 'classify' : null)}
        onDone={(o) => void finishTriage(o)}
      />
      <ClassifyInvoiceSheet
        key={`invoice-${docId}-${attempt}`}
        documentId={docId}
        open={sheet === 'invoice'}
        onOpenChange={(o) => setSheet(o ? 'invoice' : null)}
        onDone={(o) => void finishTriage(o)}
      />
      <OcrFailedSheet
        key={`ocr-${docId}-${attempt}`}
        documentId={docId}
        open={sheet === 'ocr'}
        onOpenChange={(o) => setSheet(o ? 'ocr' : null)}
        onReplaced={(o) => void finishTriage(o)}
        onRetried={() =>
          void runAction(
            () => Promise.resolve(),
            'Queued for a fresh AI run — the queue updates as it lands',
          )
        }
      />
    </div>
  );
}
