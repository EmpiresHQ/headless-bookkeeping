import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  Archive,
  FileSearch,
  FileUp,
  RefreshCw,
  ReceiptText,
} from 'lucide-react';
import {
  getPendingDraft,
  resolveSupplier,
  type NeedsTriageItem,
  type PendingDraft,
  type TriageOutcome,
} from '../api';
import type { PendingOperation } from '../lib/pendingOperation';
import { inboxKeys } from '../queries/inbox';
import { Button } from '../ui/Button';
import { toastErr } from '../ui/toast';
import { MissingEntityFactPanel } from './MissingEntityFactPanel';
import { SupplierDecisionPanel } from './SupplierDecisionPanel';

type SheetKind = 'resolve' | 'classify' | 'invoice' | 'ocr' | 'duplicate';

/** The reason types a held DRAFT can sit under (issue #404): the
 * pending-draft view is fetched for these, and the view itself says which
 * family owns the document. Includes the legacy generic buckets a pre-fix
 * missing-fact hold was mis-classified under — AND possible_duplicate,
 * because a pre-fix hold's retry could re-bucket the document as a
 * "duplicate" of its OWN first draft (production docs 260/284): the typed
 * view is the authoritative check, and a 404 (a genuine different-document
 * duplicate) keeps the ordinary duplicate-review path unchanged. */
const HELD_DRAFT_REASON_TYPES: readonly string[] = [
  'supplier_unresolved',
  'supplier_tax_status_unknown',
  'supplier_goods_vs_services_unknown',
  'classification_failed',
  'unknown',
  'possible_duplicate',
];

interface Props {
  documentId: number;
  item: NeedsTriageItem;
  /** The document's operation, owned by the screen (one at a time). */
  op: PendingOperation;
  onOpen: (sheet: SheetKind) => void;
  onArchive: () => void;
  /** Retry AI on the same document (the screen's reprocess path, issue #406). */
  onRetry: () => void;
  /** Synchronous continuation (issue #251). */
  onResolved: (outcome: TriageOutcome) => void;
}

const COPY = {
  supplier_unresolved: [
    'Supplier could not be confirmed',
    'Confirm who issued this document before the expense is booked.',
  ],
  // One missing-entity-fact family (issue #404): the supplier IS resolved
  // (matched, named); only one of its facts is not recorded. Both variants
  // get the same one-interaction confirmation panel.
  supplier_tax_status_unknown: [
    'Supplier known — one fact missing',
    'The supplier is matched. Confirm whether it is a taxable business, and the document continues automatically.',
  ],
  supplier_goods_vs_services_unknown: [
    'Supplier known — one fact missing',
    'The supplier is matched. Confirm whether it supplies goods or services, and the document continues automatically.',
  ],
  low_confidence: [
    'Review the extracted expense',
    'AI confidence is below the booking threshold. Check the saved facts.',
  ],
  category_unresolved: [
    'Choose an expense category',
    'The document was read, but its bookkeeping category needs your decision.',
  ],
  outgoing_invoice: [
    'Confirm this sales invoice',
    'This appears to be an invoice issued by your business.',
  ],
  ocr_failed: [
    'The source file could not be read',
    'Replace the file or retry OCR before classifying it.',
  ],
  classification_failed: [
    'AI classification failed',
    'The file was read fine, but the AI could not classify it. Retry the AI run or classify it manually.',
  ],
  classification_refused: [
    'The AI model declined to read this file',
    'The model refused to read the file, so it was not classified automatically. Retry the AI run once, or archive the file without booking if it is not a business document.',
  ],
  evidence_invalid: [
    'The extracted facts are not usable',
    'The AI read this document, but what it extracted does not make a purchase that can be booked automatically. The specific facts are shown below — review them and classify the document manually.',
  ],
  not_a_document: [
    'No booking is needed',
    'This file does not appear to be an accounting document.',
  ],
  possible_duplicate: [
    'This purchase may already be booked',
    'Compare this document with the existing expense before booking it again. Archive it if it is a duplicate.',
  ],
  non_postable_document: [
    'Review the document type',
    'This appears to be an order confirmation, proforma, or quote. Check for a final invoice before booking.',
  ],
  unimplemented: [
    'Review this document manually',
    'The document type is recognized but is not handled automatically yet.',
  ],
  unknown: [
    'Review this document manually',
    'There is not enough reliable information to book it automatically.',
  ],
} satisfies Record<NeedsTriageItem['reason_type'], readonly [string, string]>;

export function TriageDecisionPanel(props: Props) {
  const busy = props.op.pending;
  // API responses can contain newer, missing or invalid reason codes.
  const reasonType = Object.prototype.hasOwnProperty.call(
    COPY,
    props.item.reason_type,
  )
    ? props.item.reason_type
    : 'unknown';
  // The held-draft view is fetched for every reason a held DRAFT can sit
  // under (issue #404): the supplier-unresolved family, the two typed
  // missing-entity-fact reasons, AND the legacy buckets a pre-fix hold
  // carried (a generic classification_failed / unknown finding) — the view
  // itself says which family owns the document, so a pre-fix hold is
  // actionable without an extra Retry.
  const fetchesHeldDraft = HELD_DRAFT_REASON_TYPES.includes(reasonType);
  // A TYPED missing-fact reason owns the decision panel even while its view
  // is loading or failed to load (issue #404): the fact panel carries its
  // own loading and error states. A legacy generic bucket stays on its
  // ordinary decision until the typed view itself says this family owns
  // the document.
  const typedMissingFactReason =
    reasonType === 'supplier_tax_status_unknown' ||
    reasonType === 'supplier_goods_vs_services_unknown';
  const draftQ = useQuery({
    queryKey: inboxKeys.pendingDraft(props.documentId),
    queryFn: () => getPendingDraft(props.documentId),
    enabled: fetchesHeldDraft,
    // A 404 is an expected outcome for holds this view does not own —
    // not an error state to surface.
    retry: false,
  });
  const [title, subtitle] = COPY[reasonType];

  const resolveSuggested = (draft: PendingDraft) => {
    const proposal = draft.supplier_proposal;
    if (proposal.kind !== 'invalid_match' || !proposal.suggested_supplier)
      return;
    const { documentId } = props;
    const supplierId = proposal.suggested_supplier.id;
    props.op.run(() => resolveSupplier(documentId, supplierId), {
      onSuccess: props.onResolved,
      onError: (error) =>
        toastErr(error instanceof Error ? error.message : String(error)),
    });
  };

  return (
    <section aria-labelledby="triage-decision-title">
      <div className="mx-3.5 mb-3 rounded-lg bg-warn-bg px-3.5 py-3">
        <div className="flex items-start gap-2.5">
          <AlertTriangle className="mt-0.5 size-4 flex-none text-warn" />
          <div>
            <h2
              id="triage-decision-title"
              className="text-[14px] font-bold text-warn-deep"
            >
              {title}
            </h2>
            <p className="mt-0.5 text-[13px] leading-snug text-warn">
              {subtitle}
            </p>
            {/* Issue #405: failed extracted evidence — the SPECIFIC facts
                (what total was read, why it cannot be booked) are visible on
                the panel, not collapsed into technical details. The typed
                reason_type drives this branch; the prose is never parsed. */}
            {reasonType === 'evidence_invalid' && (
              <p className="mt-1 text-[12px] leading-snug text-warn-deep">
                {props.item.reason}
              </p>
            )}
          </div>
        </div>
      </div>

      {draftQ.data?.kind === 'missing_entity_fact' ||
      (typedMissingFactReason && (draftQ.isPending || draftQ.error != null)) ? (
        // The missing-entity-fact family (issue #404), including pre-fix
        // holds mis-bucketed under a legacy generic reason: the typed view
        // says this family owns the document, so the supplier + fact panel
        // renders regardless of the finding's reason_type.
        <MissingEntityFactPanel
          documentId={props.documentId}
          draft={
            draftQ.data?.kind === 'missing_entity_fact'
              ? draftQ.data
              : undefined
          }
          pending={draftQ.isPending}
          error={draftQ.error}
          busy={busy}
          op={props.op}
          onRetry={props.onRetry}
          onResolved={props.onResolved}
        />
      ) : props.item.reason_type === 'supplier_unresolved' ? (
        <SupplierDecisionPanel
          draft={
            draftQ.data?.kind === 'supplier_proposal' ? draftQ.data : undefined
          }
          pending={draftQ.isPending}
          error={draftQ.error}
          busy={busy}
          onResolve={() => {
            if (draftQ.data?.kind === 'supplier_proposal')
              resolveSuggested(draftQ.data);
          }}
          onChoose={() => props.onOpen('resolve')}
        />
      ) : (
        <GenericDecision {...props} reasonType={reasonType} />
      )}

      <details className="mx-3.5 mt-2 text-[12px] text-ink-2">
        <summary className="cursor-pointer py-2 font-semibold">
          Technical details
        </summary>
        <p className="break-words pb-2">{props.item.reason}</p>
      </details>
    </section>
  );
}

function GenericDecision(
  props: Props & { reasonType: NeedsTriageItem['reason_type'] },
) {
  const actions = {
    // The missing-entity-fact family (issue #404) normally renders the
    // dedicated fact panel instead; this is the fallback when the view is
    // unavailable — retry the AI run.
    supplier_tax_status_unknown: ['Retry AI', 'classify', RefreshCw],
    supplier_goods_vs_services_unknown: ['Retry AI', 'classify', RefreshCw],
    low_confidence: ['Review extracted data', 'classify', FileSearch],
    category_unresolved: ['Choose category', 'classify', FileSearch],
    outgoing_invoice: ['Review sales invoice', 'invoice', ReceiptText],
    ocr_failed: ['Replace or retry file', 'ocr', FileUp],
    classification_failed: ['Classify manually', 'classify', FileSearch],
    // Unreachable: handled by the dedicated refusal branch above (kept so
    // the action record stays total over every reason type).
    classification_refused: ['Retry AI', 'classify', FileSearch],
    // Issue #405: failed extracted evidence — the document was read, but the
    // extracted facts (e.g. a zero total) are not bookable; classify manually.
    evidence_invalid: ['Classify manually', 'classify', FileSearch],
    possible_duplicate: ['Review possible duplicate', 'duplicate', FileSearch],
    non_postable_document: ['Review document type', 'classify', FileSearch],
    unimplemented: ['Classify manually', 'classify', FileSearch],
    unknown: ['Classify manually', 'classify', FileSearch],
  } as const;
  if (props.reasonType === 'not_a_document') {
    return (
      <div className="mx-3.5 mb-3">
        <Button
          className="flex w-full items-center justify-center gap-2"
          disabled={props.op.pending}
          onClick={props.onArchive}
        >
          <Archive className="size-4" /> Archive without booking
        </Button>
      </div>
    );
  }
  if (props.reasonType === 'supplier_unresolved') return null;
  // A model refusal (issue #406): the operator path is the existing Retry AI
  // reprocess + archive-without-booking, offered directly on the decision
  // panel — no classify sheet (there is nothing extracted to review).
  if (props.reasonType === 'classification_refused') {
    return (
      <div className="mx-3.5 mb-3 flex gap-2">
        <Button
          className="flex flex-1 items-center justify-center gap-2"
          disabled={props.op.pending}
          onClick={props.onRetry}
        >
          <RefreshCw className="size-4" /> Retry AI
        </Button>
        <Button
          className="flex flex-1 items-center justify-center gap-2"
          disabled={props.op.pending}
          onClick={props.onArchive}
        >
          <Archive className="size-4" /> Archive without booking
        </Button>
      </div>
    );
  }
  const [label, sheet, Icon] = actions[props.reasonType];
  return (
    <div className="mx-3.5 mb-3">
      <Button
        className="flex w-full items-center justify-center gap-2"
        disabled={props.op.pending}
        onClick={() => props.onOpen(sheet)}
      >
        <Icon className="size-4" /> {label}
      </Button>
    </div>
  );
}
