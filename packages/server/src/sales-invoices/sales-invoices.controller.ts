import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  ConflictException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam } from '@nestjs/swagger';
import { SalesInvoicesService } from './sales-invoices.service';
import { PostingPipelineService } from '../ledger/pipeline/posting-pipeline.service';
import {
  CreateSalesInvoiceDto,
  PatchSalesInvoiceDraftDto,
  SalesInvoicePostOverrideDto,
} from './types';
import type { SalesInvoice } from './types';
import { DraftVoucher } from '../ledger/voucher/types';
import { isInvoiceNumberConflict } from './sales-invoices.service';

@ApiTags('sales-invoices')
@Controller('api/sales-invoices')
export class SalesInvoicesController {
  constructor(
    private readonly salesInvoicesService: SalesInvoicesService,
    private readonly pipeline: PostingPipelineService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'List sales invoices',
    description: 'Return all sales invoices.',
  })
  async getInvoices(): Promise<{ invoices: SalesInvoice[] }> {
    return { invoices: await this.salesInvoicesService.getInvoices() };
  }

  /** Delete a draft invoice (probe/junk cleanup). Non-draft → 409. */
  @Delete(':id')
  @ApiOperation({
    summary: 'Delete a draft sales invoice',
    description: 'Delete a draft invoice. Non-draft -> 409.',
  })
  @ApiParam({ name: 'id', description: 'Sales invoice id' })
  async deleteInvoice(@Param('id') id: string): Promise<SalesInvoice> {
    return this.salesInvoicesService.deleteDraft(Number(id));
  }

  @Post()
  @ApiOperation({
    summary: 'Create a sales invoice',
    description:
      'Create a sales invoice (draft). 409 if the invoice number already exists.',
  })
  async createInvoice(
    @Body() dto: CreateSalesInvoiceDto,
  ): Promise<SalesInvoice> {
    try {
      return await this.salesInvoicesService.createInvoice(dto);
    } catch (err) {
      if (isInvoiceNumberConflict(err)) {
        throw new ConflictException(
          `Invoice number ${dto.invoice_number} already exists`,
        );
      }
      throw err;
    }
  }

  /**
   * Correct a DRAFT invoice's amounts and supply facts, then post it again.
   *
   * The supported remedy for the 422 refusals a service sale can hit (issue
   * #209) — a wrongly stated `supply_type` / `service_place_rule`, or a VAT
   * amount that contradicts the resolved treatment. Draft/pending only; a
   * posted invoice is 409 (its voucher is immutable — reverse it instead).
   */
  @Patch(':id')
  @ApiOperation({
    summary: 'Patch a draft sales invoice',
    description:
      'Correct a draft (or pending) invoice: gross_amount, vat_amount, ' +
      'supply_type, service_place_rule. A pending invoice returns to draft and ' +
      'its approval is superseded. Posted/reversed -> 409.',
  })
  @ApiParam({ name: 'id', description: 'Sales invoice id' })
  async patchDraft(
    @Param('id') id: string,
    @Body() dto: PatchSalesInvoiceDraftDto,
  ): Promise<SalesInvoice> {
    return this.salesInvoicesService.updateDraft(Number(id), dto);
  }

  @Post(':id/generate-draft')
  @ApiOperation({
    summary: 'Generate a draft voucher for a sales invoice',
    description: 'Produce a draft voucher without posting.',
  })
  @ApiParam({ name: 'id', description: 'Sales invoice id' })
  async generateDraft(
    @Param('id') id: string,
  ): Promise<{ draft: DraftVoucher }> {
    const draft = await this.salesInvoicesService.generateDraftVoucher(
      Number(id),
    );
    return { draft };
  }

  @Post(':id/send')
  @ApiOperation({
    summary: 'Send a sales invoice',
    description: 'Mark the invoice as sent to the customer.',
  })
  @ApiParam({ name: 'id', description: 'Sales invoice id' })
  async sendInvoice(@Param('id') id: string): Promise<SalesInvoice> {
    return this.salesInvoicesService.sendInvoice(Number(id));
  }

  /**
   * Full pipeline endpoint: draft → Rules → Policy → post or hold.
   *
   * Idempotent: if the invoice is not in 'draft' status, returns 409
   * without double-posting (AC-9).
   */
  @Post(':id/post')
  @ApiOperation({
    summary: 'Post a sales invoice',
    description: 'Post the invoice to the ledger. 409 if the period is locked.',
  })
  @ApiParam({ name: 'id', description: 'Sales invoice id' })
  async postInvoice(
    @Param('id') id: string,
    @Body() override?: SalesInvoicePostOverrideDto,
  ) {
    const invoiceId = Number(id);

    // Taken BEFORE the draft is generated: whatever changes from here on — the
    // invoice's amounts or supply facts, the customer's country or tax status —
    // makes the prepared entry stale, and the pipeline refuses inside its own
    // transaction rather than posting facts nobody holds any more (issue #209).
    const factsAtDraftTime =
      await this.salesInvoicesService.draftFactsFingerprint(invoiceId);

    const result = await this.pipeline.runPipeline({
      businessObjectId: invoiceId,
      businessObjectType: 'sales_invoice',
      draftGenerator: () =>
        this.salesInvoicesService.generateDraftVoucher(invoiceId),
      assertFactsUnchanged: (trx) =>
        this.salesInvoicesService.assertDraftFactsUnchangedTx(
          trx,
          invoiceId,
          factsAtDraftTime,
        ),
      category: 'revenue',
      refetch: () => this.salesInvoicesService.getInvoiceById(invoiceId),
      override:
        override?.ruleType && override?.reason
          ? { ruleType: override.ruleType, reason: override.reason }
          : undefined,
    });

    // Preserve original API response shape
    return {
      invoice: result.businessObject,
      voucher: result.voucher,
      policy: result.policy,
    };
  }
}
