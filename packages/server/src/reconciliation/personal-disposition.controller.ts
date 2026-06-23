import { Controller, Post, Param, ParseIntPipe } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam } from '@nestjs/swagger';
import { PersonalDispositionService } from './personal-disposition.service';
import { PostedVoucher } from '../ledger/voucher/types';

@ApiTags('reconciliation')
@Controller('api')
export class PersonalDispositionController {
  constructor(private readonly service: PersonalDispositionService) {}

  /**
   * Mark a bank transaction as personal (non-business) disposition.
   *
   * Posts a voucher: Dr {plugin-resolved account} / Cr BANK_EUR
   * - sole_proprietor → Dr OWNERS_DRAWINGS / Cr BANK_EUR
   * - company → Dr SHAREHOLDER_LOAN / Cr BANK_EUR
   *
   * Per ADR-0017: NOT a business expense — no input VAT, not deductible.
   * Approval-required (tax consequences).
   */
  @ApiOperation({
    summary: 'Mark a transaction as personal',
    description: 'Classify a bank transaction as a personal disposition.',
  })
  @ApiParam({ name: 'id', description: 'Bank transaction id' })
  @Post('bank-transactions/:id/personal')
  async markAsPersonal(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<PostedVoucher> {
    return this.service.markAsPersonal(id);
  }
}
