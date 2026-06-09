import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  ParseIntPipe,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { PrepaymentService } from './prepayment.service';
import { PostedVoucher } from '../ledger/voucher/types';

/** Input for drawing down a prepayment against an invoice. */
interface DrawDownInput {
  invoice_voucher_id: number;
  amount: number;
}

/** Outstanding prepayment record returned by the list endpoint. */
interface PrepaymentRecord {
  voucher_id: number;
  account_code: string;
  original_amount: number;
  drawn_down: number;
  remaining: number;
  currency: string;
  tax_point_date: string;
}

@ApiTags('prepayments')
@Controller('api')
export class PrepaymentController {
  constructor(private readonly service: PrepaymentService) {}

  /**
   * Create a prepayment from an open bank transaction.
   *
   * For incoming (amount > 0): creates customer prepayment
   *   Dr BANK_EUR / Cr CUSTOMER_PREPAYMENTS
   *
   * For outgoing (amount < 0): creates supplier prepayment
   *   Dr SUPPLIER_PREPAYMENTS / Cr BANK_EUR
   */
  @Post('bank-transactions/:id/prepayment')
  async createPrepayment(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<PostedVoucher> {
    // The service methods validate the direction; try customer first for
    // incoming, supplier for outgoing.
    // We determine direction from the transaction itself inside the service.
    // But we need to call the right method — let the service decide.
    return this.service.createPrepaymentFromTransaction(id);
  }

  /**
   * Draw down a prepayment against an invoice.
   *
   * Creates a clearing voucher linking the prepayment to the invoice.
   */
  @Post('prepayments/:id/draw-down')
  async drawDownPrepayment(
    @Param('id', ParseIntPipe) id: number,
    @Body() input: DrawDownInput,
  ): Promise<PostedVoucher> {
    return this.service.drawDownPrepayment(
      id,
      input.invoice_voucher_id,
      input.amount,
    );
  }

  /**
   * List all outstanding prepayment vouchers with their remaining balances.
   */
  @Get('prepayments')
  async listPrepayments(): Promise<PrepaymentRecord[]> {
    const prepayments = await this.service.listOutstandingPrepayments();
    return prepayments.map((p) => ({
      voucher_id: p.voucherId,
      account_code: p.accountCode,
      original_amount: p.originalAmount,
      drawn_down: p.drawnDown,
      remaining: p.remaining,
      currency: p.currency,
      tax_point_date: p.taxPointDate,
    }));
  }
}
