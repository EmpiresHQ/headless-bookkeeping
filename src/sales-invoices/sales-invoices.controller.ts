import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  ConflictException,
} from '@nestjs/common';
import { SalesInvoicesService } from './sales-invoices.service';
import { PostingPipelineService } from '../ledger/pipeline/posting-pipeline.service';
import type { SalesInvoice, CreateSalesInvoiceDto } from './types';
import { DraftVoucher } from '../ledger/voucher/types';

@Controller('api/sales-invoices')
export class SalesInvoicesController {
  constructor(
    private readonly salesInvoicesService: SalesInvoicesService,
    private readonly pipeline: PostingPipelineService,
  ) {}

  @Get()
  async getInvoices(): Promise<{ invoices: SalesInvoice[] }> {
    return { invoices: await this.salesInvoicesService.getInvoices() };
  }

  @Post()
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
  async generateDraft(
    @Param('id') id: string,
  ): Promise<{ draft: DraftVoucher }> {
    const draft = await this.salesInvoicesService.generateDraftVoucher(
      Number(id),
    );
    return { draft };
  }

  @Post(':id/send')
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
  async postInvoice(
    @Param('id') id: string,
    @Body() override?: { ruleType: string; reason: string },
  ) {
    const invoiceId = Number(id);

    const result = await this.pipeline.runPipeline({
      businessObjectId: invoiceId,
      businessObjectType: 'sales_invoice',
      draftGenerator: () =>
        this.salesInvoicesService.generateDraftVoucher(invoiceId),
      categoryMapper: (_accountCode) => 'revenue',
      refetch: () => this.salesInvoicesService.getInvoiceById(invoiceId),
      override,
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
