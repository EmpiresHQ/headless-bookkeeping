import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  Archive,
  FileSearch,
  FileUp,
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
import { SupplierDecisionPanel } from './SupplierDecisionPanel';

type SheetKind = 'resolve' | 'classify' | 'invoice' | 'ocr' | 'duplicate';

interface Props {
  documentId: number;
  item: NeedsTriageItem;
  /** The document's operation, owned by the screen (one at a time). */
  op: PendingOperation;
  onOpen: (sheet: SheetKind) => void;
  onArchive: () => void;
  /** Synchronous continuation (issue #251). */
  onResolved: (outcome: TriageOutcome) => void;
}

const COPY = {
  supplier_unresolved: [
    'Supplier could not be confirmed',
    'Confirm who issued this document before the expense is booked.',
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
  const draftQ = useQuery({
    queryKey: inboxKeys.pendingDraft(props.documentId),
    queryFn: () => getPendingDraft(props.documentId),
    enabled: props.item.reason_type === 'supplier_unresolved',
  });
  // API responses can contain newer, missing or invalid reason codes.
  const reasonType = Object.prototype.hasOwnProperty.call(
    COPY,
    props.item.reason_type,
  )
    ? props.item.reason_type
    : 'unknown';
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
            <h1
              id="triage-decision-title"
              className="text-[14px] font-bold text-warn-deep"
            >
              {title}
            </h1>
            <p className="mt-0.5 text-[13px] leading-snug text-warn">
              {subtitle}
            </p>
          </div>
        </div>
      </div>

      {props.item.reason_type === 'supplier_unresolved' ? (
        <SupplierDecisionPanel
          draft={draftQ.data}
          pending={draftQ.isPending}
          error={draftQ.error}
          busy={busy}
          onResolve={() => {
            if (draftQ.data) resolveSuggested(draftQ.data);
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
    low_confidence: ['Review extracted data', 'classify', FileSearch],
    category_unresolved: ['Choose category', 'classify', FileSearch],
    outgoing_invoice: ['Review sales invoice', 'invoice', ReceiptText],
    ocr_failed: ['Replace or retry file', 'ocr', FileUp],
    classification_failed: ['Classify manually', 'classify', FileSearch],
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
