import { Injectable, BadRequestException } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely } from 'kysely';
import { Database } from '../database/types';
import { ExpensesService } from '../expenses/expenses.service';
import { PostingPipelineService } from '../ledger/pipeline/posting-pipeline.service';
import { TriageResult } from '../triage/types';
import { CreateExpenseDto } from '../expenses/types';

/** The posting pipeline's result shape (Rules → Policy → post/hold). */
export type PipelineRunResult = Awaited<
  ReturnType<typeof PostingPipelineService.prototype.runPipeline>
>;

/**
 * A marker the idempotency replay returns instead of re-running the pipeline:
 * the draft already exists and was already posted/held on the original pass.
 */
export interface ReplayedPipelineResult {
  replayed: true;
}

/**
 * Result of a FRESH propose-draft run — the pipeline actually executed, so
 * `pipelineResult` is the concrete pipeline output (callers may read
 * `.policy.action`).
 */
export interface ProposeDraftResult {
  expenseId: number;
  pipelineResult: PipelineRunResult;
}

/**
 * Result the workflow's idempotency replay surfaces — either a fresh run or a
 * replayed marker (the pipeline did NOT re-run). The wider union; assignable
 * from {@link ProposeDraftResult}.
 */
export interface DraftReplayResult {
  expenseId: number;
  pipelineResult: PipelineRunResult | ReplayedPipelineResult;
}

/**
 * ProposeDraftService — deterministic post-agent step that takes a validated
 * TriageResult and runs it through the existing posting pipeline.
 *
 * Flow:
 * 1. Takes a validated TriageResult with kind='new_expense'
 * 2. Calls ExpensesService.createExpense() with the result data
 * 3. Runs the existing PostingPipelineService.runPipeline() flow
 *    (generateDraftVoucher → Rules → Policy → post/hold)
 * 4. Writes an ai_proposal row for provenance audit
 *
 * Routing is NOT decided here — the IntakeWorkflowService is the single owner
 * of the `kind` + confidence decision and only ever calls this with a
 * validated, already-routed confident `new_expense`. The `kind` check below is
 * a defensive backstop (a misuse guard), not a second routing point: it throws
 * for any non-new_expense so a bypass can never produce a garbage draft.
 */
@Injectable()
export class ProposeDraftService {
  constructor(
    @InjectKysely() private readonly db: Kysely<Database>,
    private readonly expensesService: ExpensesService,
    private readonly postingPipelineService: PostingPipelineService,
  ) {}

  /**
   * Process a TriageResult through the posting pipeline.
   *
   * @param triageResult - The validated AI triage output
   * @param documentId - Optional document ID to associate with the expense
   * @param supplierId - Optional supplier ID (from supplier_proposal.match_entity_id)
   */
  async proposeDraft(
    triageResult: TriageResult,
    documentId?: number | null,
    supplierId?: number | null,
  ): Promise<ProposeDraftResult> {
    // Defensive backstop, NOT a routing point: the workflow already decided
    // this is a confident new_expense. Reject anything else so a bypass can
    // never create a garbage draft. (correction/duplicate wired in Task 43.)
    if (triageResult.kind !== 'new_expense') {
      throw new BadRequestException(
        `proposeDraft only supports kind='new_expense', got '${triageResult.kind}'. ` +
          `Routing is owned by IntakeWorkflowService; other kinds (correction, ` +
          `duplicate, unknown) will be wired in Task 43.`,
      );
    }

    // Step 1: Create the Expense via ExpensesService.
    const createExpenseDto: CreateExpenseDto = {
      document_id: documentId ?? null,
      supplier_id:
        supplierId ?? triageResult.supplier_proposal?.match_entity_id ?? null,
      category: triageResult.category,
      gross_amount: triageResult.gross_amount,
      vat_amount: triageResult.vat_amount,
      currency: triageResult.currency,
      tax_point_date: triageResult.tax_point_date,
      document_vat_marking: triageResult.document_vat_marking,
    };

    const expense = await this.expensesService.createExpense(createExpenseDto);

    // Step 2: Run the existing posting pipeline (generateDraftVoucher → Rules → Policy → post).
    // Thread confidence and supplier-known status to Policy.
    const pipelineResult = await this.postingPipelineService.runPipeline({
      businessObjectId: expense.id,
      businessObjectType: 'expense',
      draftGenerator: () =>
        this.expensesService.generateDraftVoucher(expense.id),
      category: expense.category,
      refetch: () => this.expensesService.getExpenseById(expense.id),
      confidence: triageResult.confidence,
      supplierKnown: !!supplierId,
    });

    // Step 3: Write AI provenance row (operational audit, NOT hash-chained).
    await this.writeAiProvenance(expense.id, triageResult);

    return {
      expenseId: expense.id,
      pipelineResult,
    };
  }

  /**
   * Find an Expense already drafted from a Document, if any. Used by the
   * IntakeWorkflowService idempotency guard to replay an already-triaged
   * Document's draft instead of creating a second one. Returns the lightweight
   * identity (expenseId) wrapped so an idempotent re-run is observably a no-op;
   * the full pipeline is NOT re-run.
   */
  async findExistingDraft(
    documentId: number,
  ): Promise<DraftReplayResult | undefined> {
    const expense = await this.db
      .selectFrom('expense')
      .select('id')
      .where('document_id', '=', documentId)
      .orderBy('id', 'asc')
      .executeTakeFirst();

    if (!expense) {
      return undefined;
    }

    return {
      expenseId: expense.id,
      // The pipeline already ran on the original pass; a replay does not
      // re-post. `replayed` marks this as an idempotent surfacing, not a
      // fresh pipeline run.
      pipelineResult: { replayed: true },
    };
  }

  /**
   * Persist an ai_proposal row for audit provenance.
   * Looks up the ocr_markdown artifact for the expense's document.
   */
  private async writeAiProvenance(
    expenseId: number,
    triageResult: TriageResult,
  ): Promise<void> {
    // Look up the expense's document_id to find the ocr_markdown artifact.
    const expense = await this.db
      .selectFrom('expense')
      .select('document_id')
      .where('id', '=', expenseId)
      .executeTakeFirst();

    let ocrArtifactId: number | null = null;
    if (expense?.document_id) {
      const artifact = await this.db
        .selectFrom('artifact')
        .select('id')
        .where('document_id', '=', expense.document_id)
        .where('kind', '=', 'ocr_markdown')
        .executeTakeFirst();
      ocrArtifactId = artifact?.id ?? null;
    }

    const now = Math.floor(Date.now() / 1000);
    await this.db
      .insertInto('ai_proposal')
      .values({
        business_object_type: 'expense',
        business_object_id: expenseId,
        model_id: 'openai/gpt-4o-mini',
        model_version: 'v1',
        raw_triage_result: JSON.stringify(triageResult),
        ocr_artifact_id: ocrArtifactId,
        confidence: triageResult.confidence,
        created_at: now,
      })
      .execute();
  }
}
