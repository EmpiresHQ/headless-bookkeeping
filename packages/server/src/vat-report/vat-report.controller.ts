import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Param,
  ParseIntPipe,
  MethodNotAllowedException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam } from '@nestjs/swagger';
import { VatReportService } from './vat-report.service';
import type { VatReport, KmdDeclaration } from './types';

@ApiTags('vat-report')
@Controller('api')
export class VatReportController {
  constructor(private readonly service: VatReportService) {}

  /**
   * Generate (or retrieve existing) VAT report snapshot for a reporting period.
   * POST /api/reporting-periods/:id/vat-report
   */
  @Post('reporting-periods/:id/vat-report')
  @ApiOperation({
    summary: 'Create a VAT report for a period',
    description: 'Compute and store the VAT report for a reporting period.',
  })
  @ApiParam({ name: 'id', description: 'Reporting period id' })
  async generate(
    @Param('id', ParseIntPipe) periodId: number,
  ): Promise<VatReport> {
    return this.service.generate(periodId);
  }

  /**
   * List all VAT report snapshots.
   * GET /api/vat-reports
   */
  @Get('vat-reports')
  @ApiOperation({
    summary: 'List VAT reports',
    description: 'Return all VAT reports.',
  })
  async list(): Promise<{ vat_reports: VatReport[] }> {
    return { vat_reports: await this.service.list() };
  }

  /**
   * Fetch a VAT report by ID.
   * GET /api/vat-reports/:id
   */
  @Get('vat-reports/:id')
  @ApiOperation({
    summary: 'Get a VAT report by id',
    description: 'Fetch a single VAT report.',
  })
  @ApiParam({ name: 'id', description: 'VAT report id' })
  async getById(@Param('id', ParseIntPipe) id: number): Promise<VatReport> {
    return this.service.getById(id);
  }

  /**
   * Fetch the list of voucher IDs included in a VAT report.
   * GET /api/vat-reports/:id/vouchers
   */
  @Get('vat-reports/:id/vouchers')
  @ApiOperation({
    summary: "List a VAT report's vouchers",
    description: 'Return the vouchers included in a VAT report.',
  })
  @ApiParam({ name: 'id', description: 'VAT report id' })
  async getVouchers(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<{ voucher_ids: number[] }> {
    const voucherIds = await this.service.getVoucherIds(id);
    return { voucher_ids: voucherIds };
  }

  /**
   * Build the jurisdiction VAT-return (KMD) declaration for a reporting period —
   * a derived, read-only view (the country plugin maps each base VAT code to its
   * return rows). `review_flags` lists what the accountant must confirm before
   * filing, and `vd_intra_eu_services` is the 3S total for the manual VD form.
   * GET /api/reporting-periods/:id/kmd
   */
  @Get('reporting-periods/:id/kmd')
  @ApiOperation({
    summary: 'Export KMD XML for a period',
    description: 'Render the Estonian KMD declaration XML for a period.',
  })
  @ApiParam({ name: 'id', description: 'Reporting period id' })
  async kmd(
    @Param('id', ParseIntPipe) periodId: number,
  ): Promise<KmdDeclaration> {
    return this.service.buildDeclaration(periodId);
  }

  // ── Immutability: VAT reports can never be modified ──────────────────

  @Put('vat-reports/:id')
  @ApiOperation({
    summary: 'Replace a VAT report (rejected)',
    description:
      'VAT reports are immutable; always returns 405 Method Not Allowed.',
  })
  @ApiParam({ name: 'id', description: 'VAT report id' })
  blockUpdate(): never {
    throw new MethodNotAllowedException('VAT report is immutable');
  }

  @Patch('vat-reports/:id')
  @ApiOperation({
    summary: 'Patch a VAT report (rejected)',
    description:
      'VAT reports are immutable; always returns 405 Method Not Allowed.',
  })
  @ApiParam({ name: 'id', description: 'VAT report id' })
  blockPatch(): never {
    throw new MethodNotAllowedException('VAT report is immutable');
  }

  @Delete('vat-reports/:id')
  @ApiOperation({
    summary: 'Delete a VAT report (rejected)',
    description:
      'VAT reports are immutable; always returns 405 Method Not Allowed.',
  })
  @ApiParam({ name: 'id', description: 'VAT report id' })
  blockDelete(): never {
    throw new MethodNotAllowedException('VAT report is immutable');
  }
}
