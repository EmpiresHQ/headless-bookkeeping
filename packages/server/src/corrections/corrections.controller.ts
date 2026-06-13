import { Controller, Post, Param, Body } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam } from '@nestjs/swagger';
import { CorrectionsService } from './corrections.service';
import type { CorrectionRequest, CorrectionResult } from './types';

@ApiTags('corrections')
@Controller()
export class CorrectionsController {
  constructor(private readonly correctionsService: CorrectionsService) {}

  @Post('api/expenses/:id/correct')
  @ApiOperation({ summary: 'Correct an expense', description: 'Post a correcting entry for a posted expense.' })
  @ApiParam({ name: 'id', description: 'Expense id' })
  async correctExpense(
    @Param('id') id: string,
    @Body() request: CorrectionRequest,
  ): Promise<CorrectionResult> {
    return this.correctionsService.correctExpense(Number(id), request);
  }

  @Post('api/sales-invoices/:id/correct')
  @ApiOperation({ summary: 'Correct a sales invoice', description: 'Post a correcting entry for a posted sales invoice.' })
  @ApiParam({ name: 'id', description: 'Sales invoice id' })
  async correctSalesInvoice(
    @Param('id') id: string,
    @Body() request: CorrectionRequest,
  ): Promise<CorrectionResult> {
    return this.correctionsService.correctSalesInvoice(Number(id), request);
  }
}
