import { Injectable, NotFoundException } from '@nestjs/common';
import { IntakeWorkflowService } from '../ai/intake-workflow.service';
import { DocumentsService } from '../documents/documents.service';
import { TriageOutcome } from './types';

/**
 * TriageService — the thin HTTP-facing entry into the intake spine.
 *
 * It validates the Document exists, then delegates the whole "Document ->
 * outcome" decision (including the Document's own status transition and
 * idempotency) to the IntakeWorkflowService, which is the single deep owner of
 * that transition (ADR-0024). TriageService no longer sets the Document status
 * after the fact — that previously left a crash window between routing and the
 * status move, and no single owner of the transition.
 */
@Injectable()
export class TriageService {
  constructor(
    private readonly workflow: IntakeWorkflowService,
    private readonly documents: DocumentsService,
  ) {}

  async route(documentId: number): Promise<TriageOutcome> {
    const doc = await this.documents.getById(documentId);
    if (!doc) {
      throw new NotFoundException(`Document ${documentId} not found`);
    }

    // The workflow owns routing AND the Document status transition; it is also
    // idempotent (a re-run reuses the existing finding/draft).
    const result = await this.workflow.process(documentId);

    if (result.status === 'draft_proposed') {
      return {
        kind: 'expense',
        document_id: documentId,
        expense_id: result.draft.expenseId,
      };
    }

    // needs_triage — the workflow created (or reused) the AuditFinding and
    // moved the Document to 'needs_triage'.
    return {
      kind: 'unknown',
      document_id: documentId,
      reason: result.reason,
    };
  }
}
