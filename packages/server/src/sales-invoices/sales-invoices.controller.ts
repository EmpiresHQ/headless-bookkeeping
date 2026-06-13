import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Body,
  ConflictException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam } from '@nestjs/swagger';
import { SalesInvoicesService } from './sales-invoices.service';
import { PostingPipelineService } from '../ledger/pipeline/posting-pipeline.service';
import { CreateSalesInvoiceDto, SalesInvoicePostOverrideDto } from './types';
import type { SalesInvoice } from './types';
import { DraftVoucher } from '../ledger/voucher/types';

@ApiTags('sales-invoices')
@Controller('api/sales-invoices')
export class SalesInvoicesController {
  constructor(
    private readonly salesInvoicesService: SalesInvoicesService,
    private readonly pipeline: PostingPipelineService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List sales invoices', description: 'Return all sales invoices.' })
  async getInvoices(): Promise<{ invoices: SalesInvoice[] }> {
    return { invoices: await this.salesInvoicesService.getInvoices() };
  }

  /** Delete a draft invoice (probe/junk cleanup). Non-draft → 409. */
  @Delete(':id')
  @ApiOperation({ summary: 'Delete a draft sales invoice', description: 'Delete a draft invoice. Non-draft -> 409.' })
  @ApiParam({ name: 'id', description: 'Sales invoice id' })
  async deleteInvoice(@Param('id') id: string): Promise<SalesInvoice> {
    return this.salesInvoicesService.deleteDraft(Number(id));
  }

  @Post()
  @ApiOperation({ summary: 'Create a sales invoice', description: 'Create a sales invoice (draft).' })
  async createInvoice(
    @Body() dto: CreateSalesInvoiceDto,
  ): Promise<SalesInvoice> {
    try {
      return await this.salesInvoicesService.createInvoice(dto);
    } catch (err) {
      if (this.isUniqueViolation(err)) {
        throw new ConflictException(
          `Invoice number ${dto.invoice_number} already exists`,
        );
      }
      throw err;
    }
  }

  @Post(':id/generate-draft')
  @ApiOperation({ summary: 'Generate a draft voucher for a sales invoice', description: 'Produce a draft voucher without posting.' })
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
  @ApiOperation({ summary: 'Send a sales invoice', description: 'Mark the invoice as sent to the customer.' })
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
  @ApiOperation({ summary: 'Post a sales invoice', description: 'Post the invoice to the ledger. 409 if the period is locked.' })
  @ApiParam({ name: 'id', description: 'Sales invoice id' })
  async postInvoice(
    @Param('id') id: string,
    @Body() override?: SalesInvoicePostOverrideDto,
  ) {
    const invoiceId = Number(id);

    const result = await this.pipeline.runPipeline({
      businessObjectId: invoiceId,
      businessObjectType: 'sales_invoice',
      draftGenerator: () =>
        this.salesInvoicesService.generateDraftVoucher(invoiceId),
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

  private isUniqueViolation(err: unknown): boolean {
    return (
      err instanceof Error &&
      err.message.includes('UNIQUE constraint failed') &&
      err.message.includes('invoice_number')
    );
  }
}
