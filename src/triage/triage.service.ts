import { Injectable, NotFoundException } from '@nestjs/common';
import { IntakeWorkflowService } from '../ai/intake-workflow.service';
import { DocumentsService } from '../documents/documents.service';
import { TriageOutcome } from './types';

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

    const result = await this.workflow.process(documentId);

    if (result.status === 'draft_proposed') {
      // Draft was proposed through the full pipeline (AI → Rules → Policy).
      // The expense was created and either auto-posted or held for Approval.
      await this.documents.setStatus(documentId, 'triaged');

      return {
        kind: 'expense',
        document_id: documentId,
        expense_id: result.draft.expenseId,
      };
    }

    // needs_triage — AI could not classify or confidence was too low.
    // An AuditFinding has already been created by the workflow.
    await this.documents.setStatus(documentId, 'triaged');

    return {
      kind: 'unknown',
      document_id: documentId,
      reason: result.reason,
    };
  }
}
