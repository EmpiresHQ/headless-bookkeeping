import { Controller, Get, Post, Param, Body } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ExpensesService } from './expenses.service';
import { PostingPipelineService } from '../ledger/pipeline/posting-pipeline.service';
import type { CreateExpenseDto, Expense } from './types';
import type { DraftVoucher } from '../ledger/voucher/types';

@ApiTags('expenses')
@Controller('api/expenses')
export class ExpensesController {
  constructor(
    private readonly expensesService: ExpensesService,
    private readonly pipeline: PostingPipelineService,
  ) {}

  @Post()
  async createExpense(@Body() dto: CreateExpenseDto): Promise<Expense> {
    return this.expensesService.createExpense(dto);
  }

  @Get()
  async getExpenses() {
    return { expenses: await this.expensesService.getExpenses() };
  }

  @Get(':id')
  async getExpense(@Param('id') id: string): Promise<Expense> {
    return this.expensesService.getExpenseById(Number(id));
  }

  @Post(':id/generate-draft')
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
  async postExpense(
    @Param('id') id: string,
    @Body() override?: { ruleType: string; reason: string },
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
      override,
    });

    // Preserve original API response shape
    return {
      expense: result.businessObject,
      voucher: result.voucher,
      policy: result.policy,
    };
  }
}
