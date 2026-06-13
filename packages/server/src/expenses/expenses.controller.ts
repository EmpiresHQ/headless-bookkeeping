import {
  Controller,
  Get,
  Post,
  Delete,
  Patch,
  Param,
  Body,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam } from '@nestjs/swagger';
import { ExpensesService } from './expenses.service';
import { PostingPipelineService } from '../ledger/pipeline/posting-pipeline.service';
import { CreateExpenseDto, PostOverrideDto } from './types';
import type { Expense } from './types';
import type { DraftVoucher } from '../ledger/voucher/types';

@ApiTags('expenses')
@Controller('api/expenses')
export class ExpensesController {
  constructor(
    private readonly expensesService: ExpensesService,
    private readonly pipeline: PostingPipelineService,
  ) {}

  @Post()
  @ApiOperation({ summary: 'Create an expense', description: 'Creates an expense and runs the posting pipeline (AI -> Rules -> Policy -> Voucher); may yield a draft requiring approval. 409 if the target reporting period is locked.' })
  async createExpense(@Body() dto: CreateExpenseDto): Promise<Expense> {
    return this.expensesService.createExpense(dto);
  }

  @Get()
  @ApiOperation({ summary: 'List expenses', description: 'Return all expenses.' })
  async getExpenses() {
    return { expenses: await this.expensesService.getExpenses() };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get an expense by id', description: 'Fetch a single expense.' })
  @ApiParam({ name: 'id', description: 'Expense id' })
  async getExpense(@Param('id') id: string): Promise<Expense> {
    return this.expensesService.getExpenseById(Number(id));
  }

  /** Delete a draft expense (probe/junk cleanup). Non-draft → 409. */
  @Delete(':id')
  @ApiOperation({ summary: 'Delete a draft expense', description: 'Delete a draft expense (probe/junk cleanup). Non-draft -> 409.' })
  @ApiParam({ name: 'id', description: 'Expense id' })
  async deleteExpense(@Param('id') id: string): Promise<Expense> {
    return this.expensesService.deleteDraft(Number(id));
  }

  /**
   * Set opaque document metadata on a posted expense. No ledger impact.
   * Rejected (400) when the expense's reporting period is locked.
   */
  @Patch(':id/document-metadata')
  @ApiOperation({ summary: 'Set document metadata on an expense', description: 'Set opaque document metadata on a posted expense. No ledger impact. 400 if the reporting period is locked.' })
  @ApiParam({ name: 'id', description: 'Expense id' })
  setDocumentMetadata(
    @Param('id') id: string,
    @Body() body: { supplier_invoice_number?: string | null },
  ) {
    return this.expensesService.setDocumentMetadata(Number(id), body);
  }

  @Post(':id/generate-draft')
  @ApiOperation({ summary: 'Generate a draft voucher for an expense', description: 'Produce a draft voucher for the expense without posting it.' })
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
  @ApiOperation({ summary: 'Post an expense', description: 'Post the expense to the ledger (creates a posted voucher). 409 if the period is locked.' })
  @ApiParam({ name: 'id', description: 'Expense id' })
  async postExpense(
    @Param('id') id: string,
    @Body() override?: PostOverrideDto,
  ) {
    const expenseId = Number(id);
    const expense = await this.expensesService.getExpenseById(expenseId);

    const result = await this.pipeline.runPipeline({
      businessObjectId: expenseId,
      businessObjectType: 'expense',
      draftGenerator: () =>
        this.expensesService.generateDraftVoucher(expenseId),
      category: expense.category,
      refetch: () => this.expensesService.getExpenseById(expenseId),
      override:
        override?.ruleType && override?.reason
          ? { ruleType: override.ruleType, reason: override.reason }
          : undefined,
    });

    // Preserve original API response shape
    return {
      expense: result.businessObject,
      voucher: result.voucher,
      policy: result.policy,
    };
  }
}
