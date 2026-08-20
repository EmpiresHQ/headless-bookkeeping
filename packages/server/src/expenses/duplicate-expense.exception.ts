import { ConflictException } from '@nestjs/common';
import { DuplicateDetection, DuplicateMatchKind } from './duplicate-detection';

/**
 * Raised by `ExpensesService.createExpense` when the deterministic key
 * (issue #195) recognises the incoming expense as a copy of one that already
 * exists. A 409 rather than a 400: the request is well-formed, it just
 * collides with existing state.
 *
 * The original expense id travels both on the instance (for in-process callers
 * that want to route the document to needs_triage naming the original) and in
 * the HTTP body (for API clients). An operator who disagrees re-posts with
 * `allow_duplicate: true`.
 */
export class DuplicateExpenseException extends ConflictException {
  readonly existingExpenseId: number;
  readonly matchedOn: DuplicateMatchKind;
  /**
   * `ai_document_type` of the matched expense. In-process callers need it to
   * tell the invoice+receipt email pair apart from two independent receipts:
   * only the former may be filed away without a human (issue #195).
   */
  readonly existingDocumentType: string | null;

  constructor(detection: DuplicateDetection) {
    super({
      statusCode: 409,
      error: 'Conflict',
      message: detection.reason,
      existingExpenseId: detection.existingExpenseId,
      matchedOn: detection.matchedOn,
    });
    this.existingExpenseId = detection.existingExpenseId;
    this.matchedOn = detection.matchedOn;
    this.existingDocumentType = detection.existingDocumentType;
  }
}
