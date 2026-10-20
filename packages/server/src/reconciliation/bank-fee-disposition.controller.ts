import { Controller, Post, Param, ParseIntPipe } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam } from '@nestjs/swagger';
import { BankFeeDispositionService } from './bank-fee-disposition.service';
import { PostedVoucher } from '../ledger/voucher/types';

@ApiTags('reconciliation')
@Controller('api')
export class BankFeeDispositionController {
  constructor(private readonly service: BankFeeDispositionService) {}

  /**
   * Book a converted settlement line's evidenced conversion fee as its own
   * bank-fee cost (issue #403), and reconcile its portion of the line.
   *
   * Posts: Dr EXPENSE_BANK_FEE / Cr {the line's real bank account}, plus an
   * active partial reconciliation match for the fee portion — so the fee
   * stays separated from the purchase principal while principal + fee
   * reconcile the FULL statement debit, with no duplicated expense or bank
   * line. Only the bank's OWN explicitly evidenced `conversion_fee` is
   * booked: NULL (not evidenced) is refused, never derived from a residual.
   * Explicit operator action — nothing auto-posts the fee.
   */
  @ApiOperation({
    summary: 'Book a settlement line\u2019s conversion fee as a bank fee',
    description:
      'Book the line\u2019s explicitly evidenced conversion fee as its own ' +
      'bank-fee cost and reconcile its portion of the line\u2019s debit.',
  })
  @ApiParam({ name: 'id', description: 'Bank transaction id' })
  @Post('bank-transactions/:id/bank-fee')
  async markAsBankFee(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<PostedVoucher> {
    return this.service.markAsBankFee(id);
  }
}
