import { Controller, Post, Param, ParseIntPipe } from '@nestjs/common';
import { PersonalDispositionService } from './personal-disposition.service';
import { PostedVoucher } from '../ledger/voucher/types';

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
  @Post('bank-transactions/:id/personal')
  async markAsPersonal(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<PostedVoucher> {
    return this.service.markAsPersonal(id);
  }
}
