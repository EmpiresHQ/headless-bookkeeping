import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely } from 'kysely';
import { IntakeWorkflowService } from '../ai/intake-workflow.service';
import { DocumentsService } from '../documents/documents.service';
import { Database } from '../database/types';
import { TriageOutcome, DocumentDebug, ManualClassifyDto, PendingDraft, NeedsTriageItem, classifyReasonType } from './types';

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
    @InjectKysely() private readonly db: Kysely<Database>,
  ) {}

  async getNeedsTriageItems(): Promise<NeedsTriageItem[]> {
    const rows = await this.db
      .selectFrom('document as d')
      .innerJoin('audit_finding as af', (join) =>
        join
          .onRef('af.referenced_object_id', '=', 'd.id')
          .on('af.referenced_object_type', '=', 'document')
          .on('af.finding_type', '=', 'needs_triage')
          .on('af.status', '=', 'open'),
      )
      .where('d.status', '=', 'needs_triage')
      .select(['d.id', 'd.filename', 'd.created_at', 'af.description as reason'])
      .orderBy('d.created_at', 'desc')
      .execute();

    return rows.map((r) => ({
      id: r.id,
      filename: r.filename,
      created_at: r.created_at,
      reason: r.reason,
      reason_type: classifyReasonType(r.reason ?? ''),
    }));
  }

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

  /** Read-only OCR + LLM-classification snapshot for debugging a document. */
  async debug(documentId: number): Promise<DocumentDebug> {
    const doc = await this.documents.getById(documentId);
    if (!doc) {
      throw new NotFoundException(`Document ${documentId} not found`);
    }
    return this.workflow.debug(documentId);
  }

  /** Operator-facing view of a supplier-unresolved document (404 if none). */
  async getPendingDraft(documentId: number): Promise<PendingDraft> {
    await this.documents.getById(documentId); // 404 if the document is unknown
    return this.workflow.getPendingDraft(documentId);
  }

  /**
   * Resolve the supplier on a parked document and replay it into a draft.
   * Maps the workflow outcome onto the same TriageOutcome shape `route` returns.
   */
  async resolveSupplier(
    documentId: number,
    supplierEntityId: number,
  ): Promise<TriageOutcome> {
    await this.documents.getById(documentId); // 404 if the document is unknown
    const result = await this.workflow.resolveSupplier(
      documentId,
      supplierEntityId,
    );
    if (result.status === 'draft_proposed') {
      return {
        kind: 'expense',
        document_id: documentId,
        expense_id: result.draft.expenseId,
      };
    }
    return { kind: 'unknown', document_id: documentId, reason: result.reason };
  }

  /**
   * Manually classify a needs_triage document using operator-supplied fields.
   * Maps the workflow outcome onto the same TriageOutcome shape `route` returns.
   */
  async manualClassify(
    documentId: number,
    dto: ManualClassifyDto,
  ): Promise<TriageOutcome> {
    await this.documents.getById(documentId); // 404 if unknown
    const result = await this.workflow.manualClassify(documentId, dto);
    if (result.status === 'draft_proposed') {
      return {
        kind: 'expense',
        document_id: documentId,
        expense_id: result.draft.expenseId,
      };
    }
    return { kind: 'unknown', document_id: documentId, reason: result.reason };
  }
}
