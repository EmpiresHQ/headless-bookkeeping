import {
  BadRequestException,
  Controller,
  Post,
  Get,
  Body,
  Param,
  ParseIntPipe,
  Query,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam, ApiBody } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import {
  AdvanceTaxInput,
  PrepaymentBalance,
  PrepaymentService,
} from './prepayment.service';
import { PostedVoucher } from '../ledger/voucher/types';

/** Input for drawing down a prepayment against an invoice. */
const drawDownSchema = z.object({
  invoice_voucher_id: z.number().int().positive(),
  // Minor units: whole and positive. A draw-down is never a rounding artefact.
  amount: z.number().int().positive(),
});

class DrawDownInput extends createZodDto(drawDownSchema) {}

/** The tax treatments a receipt may be given (issue #213). */
const taxTreatmentValues = [
  'taxable_supply',
  'non_taxable_deposit',
  'unresolved',
] as const;

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
  // What the money IS (issue #213). Omitted ⇒ 'unresolved': the receipt is
  // still recorded, but it is HELD — not allocatable, not settleable — until
  // somebody classifies it. An unclassified receipt is never treated as a
  // non-taxable deposit by default.
  tax_treatment: z.enum(taxTreatmentValues).optional(),
  // Required for 'taxable_supply': the jurisdiction output VAT code and WHICH
  // supply the payment is for.
  vat_code: z.string().min(1).optional(),
  supply_description: z.string().min(1).optional(),
  // The advance / pro-forma document number issued for this payment, if any.
  advance_document_number: z.string().min(1).optional(),
});

/** Input for classifying a held receipt after the fact (issue #213). */
const taxTreatmentSchema = z.object({
  tax_treatment: z.enum(['taxable_supply', 'non_taxable_deposit']),
  vat_code: z.string().min(1).optional(),
  supply_description: z.string().min(1).optional(),
  advance_document_number: z.string().min(1).optional(),
});

class TaxTreatmentInput extends createZodDto(taxTreatmentSchema) {}

/** Input for refunding a customer advance (issue #213). */
const refundSchema = z.object({
  // The OUTGOING bank line that paid the money back.
  bank_transaction_id: z.number().int().positive(),
  // The cancellation / credit document the fiscal relief is taken under.
  credit_reference: z.string().min(1),
  reason: z.string().min(1),
});

class RefundInput extends createZodDto(refundSchema) {}

/** Input for recording an advance's document number after the fact. */
const advanceDocumentSchema = z.object({
  advance_document_number: z.string().min(1),
});

class AdvanceDocumentInput extends createZodDto(advanceDocumentSchema) {}

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
  // What the money is and the VAT its receipt declared (issue #213).
  tax_treatment: string;
  vat_code: string | null;
  vat_rate_permille: number | null;
  gross_amount: number;
  declared_vat: number;
  supply_description: string | null;
  advance_document_number: string | null;
  advance_tax_point_date: string | null;
  superseded_by_advance_id: number | null;
  // Declared VAT not yet released, and the GROSS credit still available — the
  // amount a draw-down relieves against an invoice.
  remaining_vat: number | null;
  remaining_gross: number | null;
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
    description:
      'Record a prepayment from a bank transaction. State what the money is ' +
      "with 'tax_treatment': an advance on an identified taxable supply " +
      'declares its VAT at the receipt date, a non-taxable deposit declares ' +
      'nothing, and anything unclassified is recorded but HELD.',
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
    @Body() body?: Record<string, unknown>,
  ): Promise<PostedVoucher> {
    // Direction (customer vs supplier) is decided from the transaction itself
    // inside the service; ownership is established there too, at creation.
    return this.service.createPrepaymentFromTransaction(
      id,
      entityId,
      parseTaxInput(body),
    );
  }

  /**
   * The VAT treatments an advance received on a given date can be declared
   * under (issue #213) — the country plugin's answer, so a client never
   * hard-codes a jurisdiction's codes or its rate history.
   */
  @ApiOperation({
    summary: 'List advance VAT treatments',
    description:
      'The VAT codes (and the rate in force) an advance received on this ' +
      'date may declare its tax point under.',
  })
  @Get('prepayments/advance-vat-treatments')
  async listAdvanceVatTreatments(
    @Query('receipt_date') receiptDate?: string,
  ): Promise<{ treatments: { vat_code: string; rate_permille: number }[] }> {
    const date = receiptDate ?? new Date().toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new BadRequestException(
        "'receipt_date' must be a YYYY-MM-DD date — the day the money arrived.",
      );
    }
    const treatments = await this.service.listAdvanceVatTreatments(date);
    return {
      treatments: treatments.map((t) => ({
        vat_code: t.vatCode,
        rate_permille: t.ratePermille,
      })),
    };
  }

  /**
   * Say what a recorded receipt IS (issue #213): an advance on an identified
   * taxable supply, or a non-taxable deposit. The route for money that arrived
   * unclassified, including every prepayment posted before this endpoint
   * existed. Classifying as taxable reverses the gross advance and reposts it
   * split, at the same receipt tax point — no posted voucher is edited.
   */
  @ApiOperation({
    summary: "Classify a prepayment's tax treatment",
    description:
      'State whether a recorded receipt is an advance on a taxable supply or ' +
      'a non-taxable deposit.',
  })
  @ApiParam({ name: 'id', description: 'Prepayment (advance) voucher id' })
  @Post('prepayments/:id/tax-treatment')
  async classifyTaxTreatment(
    @Param('id', ParseIntPipe) id: number,
    @Body() input: TaxTreatmentInput,
  ): Promise<PrepaymentRecord> {
    const classified = await this.service.classifyAdvance(id, {
      treatment: input.tax_treatment,
      vatCode: input.vat_code,
      supplyDescription: input.supply_description,
      advanceDocumentNumber: input.advance_document_number,
    });
    return toRecord(classified);
  }

  /**
   * Record the advance invoice number a receipt was documented under
   * (issue #213) — the reference KMD INF part A reports it by. Fills an empty
   * number only; a recorded one may already be on a filed return.
   */
  @ApiOperation({
    summary: "Record an advance's document number",
    description:
      'Supply the advance (pro-forma) invoice number issued for this payment.',
  })
  @ApiParam({ name: 'id', description: 'Prepayment (advance) voucher id' })
  @Post('prepayments/:id/advance-document')
  async recordAdvanceDocument(
    @Param('id', ParseIntPipe) id: number,
    @Body() input: AdvanceDocumentInput,
  ): Promise<PrepaymentRecord> {
    return toRecord(
      await this.service.recordAdvanceDocumentNumber(
        id,
        input.advance_document_number,
      ),
    );
  }

  /**
   * Refund a customer advance, taking its declared VAT back with the money
   * (issue #213). Needs the outgoing bank line AND the cancellation/credit
   * document the relief is taken under.
   */
  @ApiOperation({
    summary: 'Refund a prepayment',
    description:
      'Pay a customer advance back and release the VAT its receipt declared.',
  })
  @ApiParam({ name: 'id', description: 'Prepayment (advance) voucher id' })
  @Post('prepayments/:id/refund')
  async refundPrepayment(
    @Param('id', ParseIntPipe) id: number,
    @Body() input: RefundInput,
  ): Promise<PostedVoucher> {
    return this.service.refundAdvance(id, {
      bankTransactionId: input.bank_transaction_id,
      creditReference: input.credit_reference,
      reason: input.reason,
    });
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
    tax_treatment: p.tax.treatment,
    vat_code: p.tax.vatCode,
    vat_rate_permille: p.tax.vatRatePermille,
    gross_amount: p.tax.grossBaseAmount,
    declared_vat: p.tax.vatBaseAmount,
    supply_description: p.tax.supplyDescription,
    advance_document_number: p.tax.advanceDocumentNumber,
    advance_tax_point_date: p.tax.advanceTaxPointDate,
    superseded_by_advance_id: p.tax.supersededByAdvanceId,
    remaining_vat: p.remainingVat,
    remaining_gross: p.remainingGross,
  };
}

/**
 * The tax facts off a create body, parsed by hand for the same reason
 * `entity_id` is: the endpoint must keep accepting a bodyless POST from
 * existing clients. An absent treatment is NOT a deposit — it is 'unresolved',
 * which the service records and HOLDS.
 */
function parseTaxInput(
  body: Record<string, unknown> | undefined,
): AdvanceTaxInput | undefined {
  if (!body) return undefined;
  const parsed = createPrepaymentSchema.safeParse(body);
  if (!parsed.success) {
    throw new BadRequestException(parsed.error.issues.map((i) => i.message));
  }
  const {
    tax_treatment,
    vat_code,
    supply_description,
    advance_document_number,
  } = parsed.data;
  if (
    tax_treatment === undefined &&
    vat_code === undefined &&
    supply_description === undefined &&
    advance_document_number === undefined
  ) {
    return undefined;
  }
  return {
    treatment: tax_treatment ?? 'unresolved',
    vatCode: vat_code,
    supplyDescription: supply_description,
    advanceDocumentNumber: advance_document_number,
  };
}
