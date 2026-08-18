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
import type { VatReport, KmdDeclaration, VatReportPreview } from './types';

@ApiTags('vat-report')
@Controller('api')
export class VatReportController {
  constructor(private readonly service: VatReportService) {}

  /**
   * FREEZE a VAT report snapshot for a reporting period (or return the existing
   * one). Not a calculator — see `preview` below for that.
   * POST /api/reporting-periods/:id/vat-report
   */
  @Post('reporting-periods/:id/vat-report')
  @ApiOperation({
    summary: 'Freeze the VAT report for a period (permanent)',
    description:
      'Compute the VAT report for a reporting period and FREEZE it as an ' +
      'immutable snapshot. The snapshot is permanent: vat_report rows reject ' +
      'UPDATE and DELETE at the database level, and a later call returns the ' +
      'stored copy unchanged rather than recomputing — so figures frozen now ' +
      'will NOT pick up vouchers posted, corrected or reversed afterwards, and ' +
      'the period lock will file this copy. Call this when filing. To see the ' +
      'current figures without freezing anything, use ' +
      'GET /api/reporting-periods/{id}/vat-report/preview instead.',
  })
  @ApiParam({ name: 'id', description: 'Reporting period id' })
  async generate(
    @Param('id', ParseIntPipe) periodId: number,
  ): Promise<VatReport> {
    return this.service.generate(periodId);
  }

  /**
   * Read-only preview: the period's current VAT figures, nothing stored.
   * GET /api/reporting-periods/:id/vat-report/preview
   */
  @Get('reporting-periods/:id/vat-report/preview')
  @ApiOperation({
    summary: 'Preview the VAT report for a period (read-only)',
    description:
      'Compute what the period currently declares WITHOUT storing anything — ' +
      'safe to call repeatedly while the period is open and vouchers are still ' +
      'moving. Returns the same figures the POST endpoint would freeze, plus ' +
      'frozen_snapshot_id: when that is non-null a snapshot already exists, ' +
      'these live figures may differ from it, and it is the frozen copy that ' +
      'filing will use.',
  })
  @ApiParam({ name: 'id', description: 'Reporting period id' })
  async previewReport(
    @Param('id', ParseIntPipe) periodId: number,
  ): Promise<VatReportPreview> {
    return this.service.preview(periodId);
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
