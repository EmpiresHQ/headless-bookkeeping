import {
  Controller,
  Post,
  Body,
  Param,
  ParseIntPipe,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam } from '@nestjs/swagger';
import { DividendsService } from './dividends.service';
import { DividendDeclarationDto, DividendSettlementDto } from './types';
import type {
  DividendDeclarationResult,
  DividendSettlementResult,
} from './types';

@ApiTags('dividends')
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
  @ApiOperation({
    summary: 'Declare a dividend',
    description: 'Declare a dividend distribution.',
  })
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
  @ApiOperation({
    summary: 'Settle a dividend',
    description: 'Settle a declared dividend against a bank transaction.',
  })
  @ApiParam({ name: 'id', description: 'Bank transaction id' })
  @Post('bank-transactions/:id/dividend')
  @HttpCode(HttpStatus.CREATED)
  async settle(
    @Param('id', ParseIntPipe) bankTransactionId: number,
    @Body() body: DividendSettlementDto,
  ): Promise<DividendSettlementResult> {
    return this.dividendsService.settle(
      bankTransactionId,
      body.declaration_voucher_id,
    );
  }
}
