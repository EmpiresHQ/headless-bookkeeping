/**
 * reasonBadge — shared label for a needs_triage reason_type.
 * Used in IntakeView (work queue) and DocumentsView (archive).
 * Task 10 will also consume this.
 */

export type ReasonType =
  | 'supplier_unresolved'
  | 'outgoing_invoice'
  | 'low_confidence'
  | 'category_unresolved'
  | 'ocr_failed'
  | 'unimplemented'
  | 'unknown';

export function reasonBadge(
  reason_type: ReasonType | null | undefined,
): string {
  switch (reason_type) {
    case 'supplier_unresolved':
      return '⚠ Unknown supplier';
    case 'outgoing_invoice':
      return '⚠ Outgoing invoice';
    case 'low_confidence':
      return '⚠ Low AI confidence';
    case 'category_unresolved':
      return '⚠ Unknown category';
    case 'ocr_failed':
      return '✗ OCR failed';
    case 'unimplemented':
      return 'ℹ Not yet implemented';
    default:
      return '⚠ Needs review';
  }
}
