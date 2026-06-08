import {
  Controller,
  Post,
  Body,
  Param,
  ParseIntPipe,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { DividendsService } from './dividends.service';
import type {
  DividendDeclarationDto,
  DividendDeclarationResult,
  DividendSettlementResult,
} from './types';

@Controller('api')
export class DividendsController {
  constructor(private readonly dividendsService: DividendsService) {}

  /**
   * Declare a dividend distribution.
   *
   * Posts a declaration voucher through the full pipeline (Rules → Policy → post):
   *   Dr RETAINED_EARNINGS / Cr DIVIDEND_PAYABLE
   *   (split with DIVIDEND_WITHHOLDING_TAX_PAYABLE when plugin rate > 0)
   */
  @Post('dividends')
  @HttpCode(HttpStatus.CREATED)
  async declare(
    @Body() dto: DividendDeclarationDto,
  ): Promise<DividendDeclarationResult> {
    return this.dividendsService.declare(dto);
  }

  /**
   * Settle a dividend against a bank transaction.
   *
   * The bank transaction must have status 'dividend'.
   * Posts a settlement voucher (Dr DIVIDEND_PAYABLE / Cr BANK) and creates
   * an N:M reconciliation_match linking the bank transaction to the
   * declaration voucher.
   */
  @Post('bank-transactions/:id/dividend')
  @HttpCode(HttpStatus.CREATED)
  async settle(
    @Param('id', ParseIntPipe) bankTransactionId: number,
    @Body() body: { declaration_voucher_id: number },
  ): Promise<DividendSettlementResult> {
    return this.dividendsService.settle(
      bankTransactionId,
      body.declaration_voucher_id,
    );
  }
}
