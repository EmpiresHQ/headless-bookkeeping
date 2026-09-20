import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  ParseIntPipe,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam, ApiBody } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { PrepaymentBalance, PrepaymentService } from './prepayment.service';
import { PostedVoucher } from '../ledger/voucher/types';

/** Input for drawing down a prepayment against an invoice. */
const drawDownSchema = z.object({
  invoice_voucher_id: z.number().int().positive(),
  // Minor units: whole and positive. A draw-down is never a rounding artefact.
  amount: z.number().int().positive(),
});

class DrawDownInput extends createZodDto(drawDownSchema) {}

/**
 * Input for creating a prepayment from a bank transaction — documentation
 * only. The body itself is OPTIONAL: existing clients POST this endpoint with
 * no body and no content-type at all, so `entity_id` is read off the body
 * directly (see below) rather than through a DTO schema, which would reject an
 * absent body outright.
 */
const createPrepaymentSchema = z.object({
  // The counterparty this advance belongs to. Optional: when omitted the
  // service resolves it from the bank transaction's own confirmed identifiers,
  // and leaves the advance UNRESOLVED (not allocatable) if it cannot.
  entity_id: z.number().int().positive().optional(),
});

class CreatePrepaymentInput extends createZodDto(createPrepaymentSchema) {}

/**
 * Input for the operator repair path: assign an unresolved advance's owner and
 * attribute historical draw-down vouchers to it explicitly.
 */
const resolveOwnershipSchema = z.object({
  entity_id: z.number().int().positive(),
  draw_downs: z
    .array(
      z.object({
        allocation_voucher_id: z.number().int().positive(),
        invoice_voucher_id: z.number().int().positive(),
      }),
    )
    .optional(),
});

class ResolveOwnershipInput extends createZodDto(resolveOwnershipSchema) {}

/** Prepayment record returned by the list endpoint. */
interface PrepaymentRecord {
  advance_id: number | null;
  voucher_id: number;
  account_code: string;
  entity_id: number | null;
  original_amount: number;
  // Null when the figure cannot be established — see `unresolved_reason`.
  drawn_down: number | null;
  remaining: number | null;
  currency: string;
  tax_point_date: string;
  allocatable: boolean;
  unresolved_reason: string | null;
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
  @ApiOperation({
    summary: 'Create a prepayment',
    description: 'Record a prepayment from a bank transaction.',
  })
  @ApiParam({ name: 'id', description: 'Bank transaction id' })
  @ApiBody({ type: CreatePrepaymentInput, required: false })
  @Post('bank-transactions/:id/prepayment')
  async createPrepayment(
    @Param('id', ParseIntPipe) id: number,
    // Read off the body so a bodyless POST (the existing client) stays valid,
    // while a supplied value is still parsed and rejected if it is not an int.
    @Body('entity_id', new ParseIntPipe({ optional: true }))
    entityId?: number,
  ): Promise<PostedVoucher> {
    // Direction (customer vs supplier) is decided from the transaction itself
    // inside the service; ownership is established there too, at creation.
    return this.service.createPrepaymentFromTransaction(id, entityId);
  }

  /**
   * Draw down a prepayment against an invoice.
   *
   * Creates a clearing voucher linking the prepayment to the invoice.
   */
  @ApiOperation({
    summary: 'Draw down a prepayment',
    description: 'Apply part of a prepayment to a liability.',
  })
  @ApiParam({ name: 'id', description: 'Prepayment id' })
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
  @ApiOperation({
    summary: 'List outstanding prepayments',
    description:
      'Return all prepayment vouchers with their remaining balances.',
  })
  @Get('prepayments')
  async listPrepayments(): Promise<PrepaymentRecord[]> {
    const prepayments = await this.service.listOutstandingPrepayments();
    return prepayments.map(toRecord);
  }

  /**
   * Resolve an advance whose owner — or whose historical draw-downs — could not
   * be established automatically (issue #201). Assigns the counterparty and
   * attributes the named draw-down vouchers to this advance and their invoices.
   * Writes reconciliation records only; no posted voucher is touched.
   */
  @ApiOperation({
    summary: 'Resolve an unresolved prepayment',
    description:
      "Assign an advance's counterparty and link its historical draw-downs.",
  })
  @ApiParam({ name: 'id', description: 'Prepayment (advance) voucher id' })
  @Post('prepayments/:id/ownership')
  async resolveOwnership(
    @Param('id', ParseIntPipe) id: number,
    @Body() input: ResolveOwnershipInput,
  ): Promise<PrepaymentRecord> {
    const resolved = await this.service.resolveAdvanceOwnership(id, {
      entityId: input.entity_id,
      drawDowns: input.draw_downs?.map((d) => ({
        allocationVoucherId: d.allocation_voucher_id,
        invoiceVoucherId: d.invoice_voucher_id,
      })),
    });
    return toRecord(resolved);
  }
}

function toRecord(p: PrepaymentBalance): PrepaymentRecord {
  return {
    advance_id: p.advanceId,
    voucher_id: p.voucherId,
    account_code: p.accountCode,
    entity_id: p.entityId,
    original_amount: p.originalAmount,
    drawn_down: p.drawnDown,
    remaining: p.remaining,
    currency: p.currency,
    tax_point_date: p.taxPointDate,
    allocatable: p.allocatable,
    unresolved_reason: p.unresolvedReason,
  };
}
