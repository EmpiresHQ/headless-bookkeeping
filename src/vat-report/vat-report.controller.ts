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
import { ApiTags } from '@nestjs/swagger';
import { VatReportService } from './vat-report.service';
import type { VatReport } from './types';

@ApiTags('vat-report')
@Controller('api')
export class VatReportController {
  constructor(private readonly service: VatReportService) {}

  /**
   * Generate (or retrieve existing) VAT report snapshot for a reporting period.
   * POST /api/reporting-periods/:id/vat-report
   */
  @Post('reporting-periods/:id/vat-report')
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
  async list(): Promise<{ vat_reports: VatReport[] }> {
    return { vat_reports: await this.service.list() };
  }

  /**
   * Fetch a VAT report by ID.
   * GET /api/vat-reports/:id
   */
  @Get('vat-reports/:id')
  async getById(@Param('id', ParseIntPipe) id: number): Promise<VatReport> {
    return this.service.getById(id);
  }

  /**
   * Fetch the list of voucher IDs included in a VAT report.
   * GET /api/vat-reports/:id/vouchers
   */
  @Get('vat-reports/:id/vouchers')
  async getVouchers(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<{ voucher_ids: number[] }> {
    const voucherIds = await this.service.getVoucherIds(id);
    return { voucher_ids: voucherIds };
  }

  // ── Immutability: VAT reports can never be modified ──────────────────

  @Put('vat-reports/:id')
  blockUpdate(): never {
    throw new MethodNotAllowedException('VAT report is immutable');
  }

  @Patch('vat-reports/:id')
  blockPatch(): never {
    throw new MethodNotAllowedException('VAT report is immutable');
  }

  @Delete('vat-reports/:id')
  blockDelete(): never {
    throw new MethodNotAllowedException('VAT report is immutable');
  }
}
