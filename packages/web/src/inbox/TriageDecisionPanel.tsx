import { useState } from 'react';
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
import { inboxKeys } from '../queries/inbox';
import { Button } from '../ui/Button';
import { toastErr } from '../ui/toast';
import { SupplierDecisionPanel } from './SupplierDecisionPanel';

type SheetKind = 'resolve' | 'classify' | 'invoice' | 'ocr';

interface Props {
  documentId: number;
  item: NeedsTriageItem;
  busy: boolean;
  onOpen: (sheet: SheetKind) => void;
  onArchive: () => void;
  onResolved: (outcome: TriageOutcome) => Promise<void>;
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
  not_a_document: [
    'No booking is needed',
    'This file does not appear to be an accounting document.',
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
  const [resolving, setResolving] = useState(false);
  const draftQ = useQuery({
    queryKey: inboxKeys.pendingDraft(props.documentId),
    queryFn: () => getPendingDraft(props.documentId),
    enabled: props.item.reason_type === 'supplier_unresolved',
  });
  const [title, subtitle] = COPY[props.item.reason_type];

  const resolveSuggested = async (draft: PendingDraft) => {
    const proposal = draft.supplier_proposal;
    if (proposal.kind !== 'invalid_match' || !proposal.suggested_supplier)
      return;
    setResolving(true);
    try {
      await props.onResolved(
        await resolveSupplier(props.documentId, proposal.suggested_supplier.id),
      );
    } catch (error) {
      toastErr(error instanceof Error ? error.message : String(error));
      setResolving(false);
    }
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
          busy={props.busy || resolving}
          onResolve={() => {
            if (draftQ.data) void resolveSuggested(draftQ.data);
          }}
          onChoose={() => props.onOpen('resolve')}
        />
      ) : (
        <GenericDecision {...props} />
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

function GenericDecision(props: Props) {
  const actions = {
    low_confidence: ['Review extracted data', 'classify', FileSearch],
    category_unresolved: ['Choose category', 'classify', FileSearch],
    outgoing_invoice: ['Review sales invoice', 'invoice', ReceiptText],
    ocr_failed: ['Replace or retry file', 'ocr', FileUp],
    unimplemented: ['Classify manually', 'classify', FileSearch],
    unknown: ['Classify manually', 'classify', FileSearch],
  } as const;
  if (props.item.reason_type === 'not_a_document') {
    return (
      <div className="mx-3.5 mb-3">
        <Button
          className="flex w-full items-center justify-center gap-2"
          disabled={props.busy}
          onClick={props.onArchive}
        >
          <Archive className="size-4" /> Archive without booking
        </Button>
      </div>
    );
  }
  if (props.item.reason_type === 'supplier_unresolved') return null;
  const [label, sheet, Icon] = actions[props.item.reason_type];
  return (
    <div className="mx-3.5 mb-3">
      <Button
        className="flex w-full items-center justify-center gap-2"
        disabled={props.busy}
        onClick={() => props.onOpen(sheet)}
      >
        <Icon className="size-4" /> {label}
      </Button>
    </div>
  );
}
