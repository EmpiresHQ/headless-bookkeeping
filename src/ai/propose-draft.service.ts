import { Injectable, BadRequestException } from '@nestjs/common';
import { ExpensesService } from '../expenses/expenses.service';
import { PostingPipelineService } from '../ledger/pipeline/posting-pipeline.service';
import { TriageResult } from '../triage/types';
import { CreateExpenseDto } from '../expenses/types';

/**
 * Result of the propose-draft pipeline.
 */
export interface ProposeDraftResult {
  expenseId: number;
  pipelineResult: Awaited<ReturnType<typeof PostingPipelineService.prototype.runPipeline>>;
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
 *
 * Only handles kind='new_expense'; other kinds throw (to be wired in Task 43).
 */
@Injectable()
export class ProposeDraftService {
  constructor(
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
    // Only handle new_expense for now; other kinds deferred to Task 43.
    if (triageResult.kind !== 'new_expense') {
      throw new BadRequestException(
        `proposeDraft only supports kind='new_expense', got '${triageResult.kind}'. ` +
          `Other kinds (correction, duplicate, unknown) will be wired in Task 43.`,
      );
    }

    // Step 1: Create the Expense via ExpensesService.
    const createExpenseDto: CreateExpenseDto = {
      document_id: documentId ?? null,
      supplier_id: supplierId ?? triageResult.supplier_proposal?.match_entity_id ?? null,
      category: triageResult.category,
      gross_amount: triageResult.gross_amount,
      vat_amount: triageResult.vat_amount,
      currency: triageResult.currency,
      tax_point_date: triageResult.tax_point_date,
      document_vat_marking: triageResult.document_vat_marking,
    };

    const expense = await this.expensesService.createExpense(createExpenseDto);

    // Step 2: Run the existing posting pipeline (generateDraftVoucher → Rules → Policy → post).
    const pipelineResult = await this.postingPipelineService.runPipeline({
      businessObjectId: expense.id,
      businessObjectType: 'expense',
      draftGenerator: () =>
        this.expensesService.generateDraftVoucher(expense.id),
      category: expense.category,
      refetch: () => this.expensesService.getExpenseById(expense.id),
    });

    return {
      expenseId: expense.id,
      pipelineResult,
    };
  }
}
