import { Controller, Post, Param, Body } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CorrectionsService } from './corrections.service';
import type { CorrectionRequest, CorrectionResult } from './types';

@ApiTags('corrections')
@Controller()
export class CorrectionsController {
  constructor(private readonly correctionsService: CorrectionsService) {}

  @Post('api/expenses/:id/correct')
  async correctExpense(
    @Param('id') id: string,
    @Body() request: CorrectionRequest,
  ): Promise<CorrectionResult> {
    return this.correctionsService.correctExpense(Number(id), request);
  }

  @Post('api/sales-invoices/:id/correct')
  async correctSalesInvoice(
    @Param('id') id: string,
    @Body() request: CorrectionRequest,
  ): Promise<CorrectionResult> {
    return this.correctionsService.correctSalesInvoice(Number(id), request);
  }
}
