import {
  Controller,
  Get,
  Post,
  Delete,
  Patch,
  Param,
  Body,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiParam,
  ApiOkResponse,
} from '@nestjs/swagger';
import { ExpensesService } from './expenses.service';
import { PostingPipelineService } from '../ledger/pipeline/posting-pipeline.service';
import { FixedAssetRegistrarService } from '../fixed-assets/fixed-asset-registrar.service';
import {
  CreateExpenseDto,
  PatchExpenseDraftDto,
  PostOverrideDto,
} from './types';
import type { Expense } from './types';
import type { DraftVoucher } from '../ledger/voucher/types';
import {
  expenseResponseSchema,
  expensesListResponseSchema,
} from '../openapi-response-schemas';

@ApiTags('expenses')
@Controller('api/expenses')
export class ExpensesController {
  constructor(
    private readonly expensesService: ExpensesService,
    private readonly pipeline: PostingPipelineService,
    private readonly registrar: FixedAssetRegistrarService,
  ) {}

  @Post()
  @ApiOperation({
    summary: 'Create an expense',
    description:
      'Creates an expense and runs the posting pipeline (AI -> Rules -> Policy -> Voucher); may yield a draft requiring approval. 409 if the target reporting period is locked.',
  })
  async createExpense(@Body() dto: CreateExpenseDto): Promise<Expense> {
    return this.expensesService.createExpense(dto);
  }

  @Get()
  @ApiOperation({
    summary: 'List expenses',
    description: 'Return all expenses.',
  })
  @ApiOkResponse({ schema: expensesListResponseSchema })
  async getExpenses() {
    return { expenses: await this.expensesService.getExpenses() };
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get an expense by id',
    description: 'Fetch a single expense.',
  })
  @ApiParam({ name: 'id', description: 'Expense id' })
  @ApiOkResponse({ schema: expenseResponseSchema })
  async getExpense(@Param('id') id: string): Promise<Expense> {
    return this.expensesService.getExpenseById(Number(id));
  }

  /** Delete a draft expense (probe/junk cleanup). Non-draft → 409. */
  @Delete(':id')
  @ApiOperation({
    summary: 'Delete a draft expense',
    description:
      'Delete a draft expense (probe/junk cleanup). Non-draft -> 409.',
  })
  @ApiParam({ name: 'id', description: 'Expense id' })
  async deleteExpense(@Param('id') id: string): Promise<Expense> {
    return this.expensesService.deleteDraft(Number(id));
  }

  /**
   * Edit a DRAFT expense's facts in place, then submit it again (issue #247).
   *
   * The remedy a rejection or a posting refusal points at: the SAME expense
   * keeps its source document, AI facts and approval history. Draft/pending
   * only; a posted/reversed expense is 409 (its voucher is immutable — use
   * POST /api/expenses/:id/correct). Saving never posts.
   */
  @Patch(':id')
  @ApiOperation({
    summary: 'Edit a draft expense',
    description:
      'Edit a draft (or pending) expense: category, supplier_id, gross_amount, ' +
      'vat_amount (integer cents), currency, tax_point_date, ' +
      'supplier_invoice_number, claimant_id, company_addressed_receipt. A ' +
      'pending expense returns to draft and its approval is superseded. ' +
      'Provenance (document_id, AI facts) is not editable (400). Changing the ' +
      'duplicate key onto another expense is 409 unless allow_duplicate. ' +
      'Posted/reversed -> 409. Never posts.',
  })
  @ApiParam({ name: 'id', description: 'Expense id' })
  @ApiOkResponse({ schema: expenseResponseSchema })
  async patchDraft(
    @Param('id') id: string,
    @Body() dto: PatchExpenseDraftDto,
  ): Promise<Expense> {
    return this.expensesService.updateDraft(Number(id), dto);
  }

  /**
   * Set opaque document metadata on a posted expense. No ledger impact.
   * Rejected (400) when the expense's reporting period is locked.
   */
  @Patch(':id/document-metadata')
  @ApiOperation({
    summary: 'Set document metadata on an expense',
    description:
      'Set opaque document metadata on a posted expense. No ledger impact. 400 if the reporting period is locked.',
  })
  @ApiParam({ name: 'id', description: 'Expense id' })
  setDocumentMetadata(
    @Param('id') id: string,
    @Body() body: { supplier_invoice_number?: string | null },
  ) {
    return this.expensesService.setDocumentMetadata(Number(id), body);
  }

  @Post(':id/generate-draft')
  @ApiOperation({
    summary: 'Generate a draft voucher for an expense',
    description: 'Produce a draft voucher for the expense without posting it.',
  })
  @ApiParam({ name: 'id', description: 'Expense id' })
  async generateDraft(@Param('id') id: string): Promise<DraftVoucher> {
    return this.expensesService.generateDraftVoucher(Number(id));
  }

  /**
   * Full pipeline endpoint: draft → Rules → Policy → post or hold.
   *
   * Idempotent: if the expense is not in 'draft' status, returns 409
   * without double-posting (AC-9).
   */
  @Post(':id/post')
  @ApiOperation({
    summary: 'Post an expense',
    description:
      'Post the expense to the ledger (creates a posted voucher). 409 if the period is locked.',
  })
  @ApiParam({ name: 'id', description: 'Expense id' })
  async postExpense(
    @Param('id') id: string,
    @Body() override?: PostOverrideDto,
  ) {
    const expenseId = Number(id);
    const expense = await this.expensesService.getExpenseById(expenseId);

    // Taken BEFORE the draft is generated: whatever changes from here on — the
    // expense's amounts or category, the supplier's country or tax status —
    // makes the prepared entry stale, and the pipeline refuses inside its own
    // transaction rather than posting facts nobody holds any more. The supplier
    // facts decide the acquisition's KMD row (issue #210), so the same
    // protection the sales side got in #209 belongs here.
    const factsAtDraftTime =
      await this.expensesService.draftFactsFingerprint(expenseId);

    const result = await this.pipeline.runPipeline({
      businessObjectId: expenseId,
      businessObjectType: 'expense',
      draftGenerator: () =>
        this.expensesService.generateDraftVoucher(expenseId),
      assertFactsUnchanged: (trx) =>
        this.expensesService.assertDraftFactsUnchangedTx(
          trx,
          expenseId,
          factsAtDraftTime,
        ),
      category: expense.category,
      refetch: () => this.expensesService.getExpenseById(expenseId),
      override:
        override?.ruleType && override?.reason
          ? { ruleType: override.ruleType, reason: override.reason }
          : undefined,
      afterPost: (trx, voucher) =>
        this.registrar.registerFromVoucher(trx, voucher, expenseId),
    });

    // Preserve original API response shape
    return {
      expense: result.businessObject,
      voucher: result.voucher,
      policy: result.policy,
    };
  }
}
