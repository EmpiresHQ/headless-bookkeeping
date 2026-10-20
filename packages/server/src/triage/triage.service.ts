import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely } from 'kysely';
import {
  IntakeWorkflowService,
  IntakeWorkflowResult,
} from '../ai/intake-workflow.service';
import { DocumentsService } from '../documents/documents.service';
import { Database } from '../database/types';
import {
  TriageOutcome,
  DocumentDebug,
  ManualClassifyDto,
  NeedsTriageItem,
  ConfirmEntityFactDto,
  MissingEntityFact,
  resolveReasonType,
} from './types';
import type { AnyPendingDraft } from './pending-draft';

/** The HTTP-facing confirmation result (issue #404): the operation result
 * (fact_saved — the fact was recorded on the entity) alongside the CURRENT
 * processing outcome (posted, or held on the next genuine gate). */
export interface ConfirmEntityFactResponse {
  document_id: number;
  entity_id: number | null;
  fact: MissingEntityFact;
  value: string;
  fact_saved: boolean;
  outcome: TriageOutcome;
}

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
      .select([
        'd.id',
        'd.filename',
        'd.created_at',
        'af.description as reason',
        'af.reason_type',
      ])
      .orderBy('d.created_at', 'desc')
      .execute();

    return rows.map((r) => ({
      id: r.id,
      filename: r.filename,
      created_at: r.created_at,
      reason: r.reason,
      reason_type: resolveReasonType(r.reason_type, r.reason ?? ''),
    }));
  }

  async route(documentId: number): Promise<TriageOutcome> {
    const doc = await this.documents.getById(documentId);
    if (!doc) {
      throw new NotFoundException(`Document ${documentId} not found`);
    }

    // The workflow owns routing AND the Document status transition; it is also
    // idempotent (a re-run reuses the existing finding/draft).
    return this.toTriageOutcome(
      documentId,
      await this.workflow.process(documentId),
    );
  }

  /**
   * Map any {@link IntakeWorkflowResult} onto the HTTP-facing TriageOutcome.
   *
   * ONE mapper for every entry point (`route`, `resolveSupplier`,
   * `manualClassify`). The three used to map their own subset, each narrowing
   * the union with an `as` cast on the way out, so a new workflow outcome
   * compiled everywhere and was reported correctly in only one place: a
   * `receipt_matched` reached the operator as "still needs review" from
   * `resolveSupplier` while the workflow had already filed the document as
   * `processed`. The switch below is exhaustive, so the compiler now names
   * every entry point the next outcome has to be considered in.
   */
  private toTriageOutcome(
    documentId: number,
    result: IntakeWorkflowResult,
  ): TriageOutcome {
    switch (result.status) {
      case 'draft_proposed':
        return {
          kind: 'expense',
          document_id: documentId,
          expense_id: result.draft.expenseId,
        };

      case 'draft_proposed_invoice':
        return {
          kind: 'invoice',
          document_id: documentId,
          invoice_id: result.invoiceId,
        };

      case 'bank_import_started':
        return {
          kind: 'bank_statement',
          document_id: documentId,
          job_id: result.jobId,
        };

      case 'receipt_matched':
        // The document evidences an expense that already exists (issue #195):
        // no second expense was created, and the workflow has already filed the
        // document as `processed` and resolved its finding — so the caller is
        // told which expense it belongs to rather than being handed an
        // 'unknown' the UI renders as "still needs review".
        return {
          kind: 'expense',
          document_id: documentId,
          expense_id: result.expenseId,
        };

      case 'needs_triage':
        // The workflow created (or reused) the AuditFinding and moved the
        // Document to 'needs_triage'.
        return {
          kind: 'unknown',
          document_id: documentId,
          reason: result.reason,
        };
    }
  }

  /** Read-only OCR + LLM-classification snapshot for debugging a document.
   * @deprecated Use {@link details} instead.
   */
  async debug(documentId: number): Promise<DocumentDebug> {
    const doc = await this.documents.getById(documentId);
    if (!doc) {
      throw new NotFoundException(`Document ${documentId} not found`);
    }
    return this.workflow.debug(documentId);
  }

  /**
   * Read-only details: OCR from cache + classification from the linked draft
   * Expense. NEVER re-invokes the LLM (ADR-0039).
   */
  async details(documentId: number): Promise<DocumentDebug> {
    const doc = await this.documents.getById(documentId);
    if (!doc) {
      throw new NotFoundException(`Document ${documentId} not found`);
    }
    return this.workflow.details(documentId);
  }

  /**
   * The one-interaction confirmation of a missing entity fact (issue #404):
   * record the operator's chosen fact through the legitimate entity-update
   * path and resume intake for the document chain. The response reports the
   * OPERATION RESULT (`fact_saved`) and the CURRENT processing outcome
   * separately — a saved fact that still parks on the next genuine gate is
   * reported as exactly that, never as a posting.
   */
  async confirmEntityFact(
    documentId: number,
    dto: ConfirmEntityFactDto,
  ): Promise<ConfirmEntityFactResponse> {
    const doc = await this.documents.getById(documentId);
    if (!doc) {
      throw new NotFoundException(`Document ${documentId} not found`);
    }
    const result = await this.workflow.confirmEntityFact(
      documentId,
      dto.fact as MissingEntityFact,
      dto.value,
    );
    return {
      document_id: result.document_id,
      entity_id: result.entity_id,
      fact: result.fact,
      value: result.value,
      fact_saved: result.fact_saved,
      outcome: this.toTriageOutcome(documentId, result.outcome),
    };
  }

  /** Operator-facing view of a HELD document (404 if none) — the
   * supplier-unresolved proposal or the missing-entity-fact family's typed
   * supplier + fact view (issue #404). */
  async getPendingDraft(documentId: number): Promise<AnyPendingDraft> {
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
    return this.toTriageOutcome(
      documentId,
      await this.workflow.resolveSupplier(documentId, supplierEntityId),
    );
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
    return this.toTriageOutcome(
      documentId,
      await this.workflow.manualClassify(documentId, dto),
    );
  }
}
