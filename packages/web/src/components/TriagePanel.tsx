import type { TriageReasonType } from '../api';
import { ResolveSupplierForm } from './ResolveSupplierForm';
import { TriageManualForm } from './TriageManualForm';
import { TriageOcrFailedForm } from './TriageOcrFailedForm';
import { TriageManualInvoiceForm } from './TriageManualInvoiceForm';

/**
 * The actionable triage UI for a single needs_triage document — the right form
 * for the document's `reason_type`. Extracted from IntakeView so the SAME triage
 * affordances are available inline in the Documents archive (a human can resolve
 * a parked document without bouncing to the Intake tab).
 *
 * Reasons with no form (unimplemented / unknown / not_a_document) show their
 * human-readable reason text — the actionable next step for those is a quick
 * action (Retry / Delete) owned by the host view, not a form here.
 */
export function TriagePanel({
  documentId,
  reasonType,
  reason,
  onDone,
  onCancel,
}: {
  documentId: number;
  reasonType: TriageReasonType | null;
  reason?: string | null;
  onDone: () => void;
  onCancel: () => void;
}) {
  switch (reasonType) {
    case 'supplier_unresolved':
      return (
        <ResolveSupplierForm
          documentId={documentId}
          onDone={onDone}
          onCancel={onCancel}
        />
      );
    case 'low_confidence':
    case 'category_unresolved':
      return (
        <TriageManualForm
          documentId={documentId}
          onDone={onDone}
          onCancel={onCancel}
        />
      );
    case 'ocr_failed':
      return (
        <TriageOcrFailedForm
          documentId={documentId}
          onDone={onDone}
          onCancel={onCancel}
        />
      );
    case 'outgoing_invoice':
      return (
        <TriageManualInvoiceForm
          documentId={documentId}
          onDone={onDone}
          onCancel={onCancel}
        />
      );
    default:
      return (
        <div className="px-3 py-2 bg-gray-50 text-xs text-gray-500">
          {reason ?? 'Held for human review.'}
        </div>
      );
  }
}
