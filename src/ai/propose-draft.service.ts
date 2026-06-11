import { Injectable, BadRequestException } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely } from 'kysely';
import { Database } from '../database/types';
import { ExpensesService } from '../expenses/expenses.service';
import { EntitiesService } from '../entities/entities.service';
import { PostingPipelineService } from '../ledger/pipeline/posting-pipeline.service';
import { SupplierProposal, TriageResult } from '../triage/types';
import { CreateExpenseDto } from '../expenses/types';
import { AgentConfigService } from './agent-config.service';
import { CategoryService } from '../categories/category.service';

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
  outcome: 'draft';
  expenseId: number;
  pipelineResult: PipelineRunResult;
}

/**
 * Result when proposeDraft could NOT produce a draft because the
 * supplier_proposal asked to CREATE a Supplier — deferred (Task 43). No draft
 * is created (no null-supplier silent drop); the caller routes to needs_triage
 * with {@link reason}.
 */
export interface SupplierUnresolvedResult {
  outcome: 'supplier-unresolved';
  reason: string;
}

/**
 * Returned when the triage `category` is not in the active country plugin's
 * category set. Like supplier-unresolved, the caller routes it to needs_triage
 * rather than silently booking to EXPENSE_OTHER (ADR-0002).
 */
export interface CategoryUnresolvedResult {
  outcome: 'category-unresolved';
  reason: string;
}

/**
 * Discriminated outcome of a fresh proposeDraft call: either a created draft
 * or an explicit "supplier could not be resolved, route to triage" signal, or
 * an explicit "category not in the active plugin's category set, route to
 * triage" signal.
 */
export type ProposeDraftOutcome =
  | ProposeDraftResult
  | SupplierUnresolvedResult
  | CategoryUnresolvedResult;

/**
 * Result the workflow's idempotency replay surfaces — either a fresh run or a
 * replayed marker (the pipeline did NOT re-run). The wider union; assignable
 * from {@link ProposeDraftResult}.
 */
export interface DraftReplayResult {
  outcome: 'draft';
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
    private readonly entitiesService: EntitiesService,
    private readonly postingPipelineService: PostingPipelineService,
    private readonly config: AgentConfigService,
    private readonly categoryService: CategoryService,
  ) {}

  /**
   * Process a TriageResult through the posting pipeline.
   *
   * Returns a discriminated {@link ProposeDraftOutcome}: a created draft, or an
   * explicit `supplier-unresolved` signal when the supplier_proposal asks to
   * CREATE a Supplier (deferred — Task 43), or a `category-unresolved` signal
   * when the AI emits a category outside the active plugin's set (both route to
   * needs_triage). The former is NEVER a silent null-supplier draft; the caller
   * routes it to needs_triage.
   *
   * @param triageResult - The validated AI triage output
   * @param documentId - Optional document ID to associate with the expense
   * @param supplierId - Optional explicit supplier ID. When omitted, the
   *   supplier is resolved from `triageResult.supplier_proposal` (a 'match'
   *   proposal resolves to its entity id; a 'create' proposal is unresolved).
   */
  async proposeDraft(
    triageResult: TriageResult,
    documentId?: number | null,
    supplierId?: number | null,
  ): Promise<ProposeDraftOutcome> {
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

    // Category guard: the model is given the closed category set (Task 4) but
    // Zod admits any string. If the emitted category is not in the active
    // plugin's set, return an explicit signal so the caller routes to
    // needs_triage rather than letting createExpense throw a 500 or silently
    // booking to EXPENSE_OTHER (ADR-0002/0024).
    if (!(await this.categoryService.isValid(triageResult.category))) {
      return {
        outcome: 'category-unresolved',
        reason: `new_expense has an unknown category '${triageResult.category}'`,
      };
    }

    // Step 0: EXPLICIT supplier resolution. A 'match' proposal resolves to its
    // entity id; a 'create' proposal find-or-onboards the Supplier from the
    // document evidence (ADR-0014). Only a genuine onboard failure stays
    // unresolved → needs_triage; we never silently produce a null-supplier draft.
    const resolved = await this.resolveSupplier(
      triageResult.supplier_proposal,
      supplierId,
    );
    if (resolved.outcome === 'supplier-unresolved') {
      return resolved;
    }
    const resolvedSupplierId = resolved.supplierId;

    // Step 1: Create the Expense via ExpensesService.
    const createExpenseDto: CreateExpenseDto = {
      document_id: documentId ?? null,
      supplier_id: resolvedSupplierId,
      category: triageResult.category,
      gross_amount: triageResult.gross_amount,
      vat_amount: triageResult.vat_amount,
      currency: triageResult.currency,
      tax_point_date: triageResult.tax_point_date,
      document_vat_marking: triageResult.document_vat_marking,
      supplier_invoice_number: triageResult.supplier_invoice_number,
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
      supplierKnown: resolvedSupplierId !== null,
    });

    // Step 3: Write AI provenance row (operational audit, NOT hash-chained).
    await this.writeAiProvenance(expense.id, triageResult);

    return {
      outcome: 'draft',
      expenseId: expense.id,
      pipelineResult,
    };
  }

  /**
   * Resolve a supplier_proposal (plus any explicit override) to a concrete
   * Supplier id — the EXPLICIT proposal→Supplier step (ADR-0014, ADR-0024).
   *
   * - An explicit `supplierId` (already resolved by the caller) wins.
   * - A `{ mode: 'match', match_entity_id }` proposal resolves to that id.
   * - A `{ mode: 'create', ... }` proposal find-or-onboards the Supplier on its
   *   registration key (ADR-0014): an existing key is reused (idempotent /
   *   race-safe), otherwise a new Supplier Entity is created. Only a genuine
   *   onboard failure is reported `supplier-unresolved` → needs_triage.
   * - No proposal at all resolves to a null supplier (Policy gates unknown
   *   suppliers downstream), preserving the prior behavior.
   */
  private async resolveSupplier(
    proposal: SupplierProposal | undefined,
    explicitSupplierId?: number | null,
  ): Promise<
    | { outcome: 'resolved'; supplierId: number | null }
    | SupplierUnresolvedResult
  > {
    if (explicitSupplierId != null) {
      return { outcome: 'resolved', supplierId: explicitSupplierId };
    }
    if (!proposal) {
      return { outcome: 'resolved', supplierId: null };
    }
    if (proposal.mode === 'match') {
      return { outcome: 'resolved', supplierId: proposal.match_entity_id };
    }
    // mode === 'create' — find-or-onboard the Supplier from the document.
    try {
      const existing = await this.entitiesService.findByRegistrationKey(
        proposal.create_registration_key,
      );
      if (existing) {
        return { outcome: 'resolved', supplierId: existing.id };
      }
      const created = await this.entitiesService.onboard({
        role: 'supplier',
        country: proposal.create_country,
        name: proposal.create_name,
        registrationKey: proposal.create_registration_key,
      });
      return { outcome: 'resolved', supplierId: created.id };
    } catch (e) {
      return {
        outcome: 'supplier-unresolved',
        reason: `supplier creation failed: ${
          e instanceof Error ? e.message : String(e)
        }`,
      };
    }
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
      outcome: 'draft',
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
        model_id: await this.config.resolveModel('triage'),
        model_version: 'v1',
        raw_triage_result: JSON.stringify(triageResult),
        ocr_artifact_id: ocrArtifactId,
        confidence: triageResult.confidence,
        created_at: now,
      })
      .execute();
  }
}
