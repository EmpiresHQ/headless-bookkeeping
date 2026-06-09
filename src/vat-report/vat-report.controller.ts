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
  async generate(
    @Param('id', ParseIntPipe) periodId: number,
  ): Promise<VatReport> {
    return this.service.generate(periodId);
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

  /**
   * Build the jurisdiction VAT-return (KMD) declaration for a reporting period —
   * a derived, read-only view (the country plugin maps each base VAT code to its
   * return rows). `review_flags` lists what the accountant must confirm before
   * filing, and `vd_intra_eu_services` is the 3S total for the manual VD form.
   * GET /api/reporting-periods/:id/kmd
   */
  @Get('reporting-periods/:id/kmd')
  async kmd(
    @Param('id', ParseIntPipe) periodId: number,
  ): Promise<KmdDeclaration> {
    return this.service.buildDeclaration(periodId);
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
