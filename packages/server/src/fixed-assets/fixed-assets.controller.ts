import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  ParseIntPipe,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { FixedAssetsService } from './fixed-assets.service';
import { DepreciationAttributionService } from './depreciation-attribution.service';
import { DepreciationAllocationDto, DisposeAssetDto } from './types';

@ApiTags('fixed-assets')
@Controller('api/fixed-assets')
export class FixedAssetsController {
  constructor(
    private readonly service: FixedAssetsService,
    private readonly attribution: DepreciationAttributionService,
  ) {}

  @Get()
  async list() {
    return { fixedAssets: await this.service.list() };
  }

  /**
   * Depreciation posted on an ACCUM_DEPRECIATION_* account that is not
   * attributed to individual assets — a close from before migration 075 whose
   * split could not be re-derived, a hand-posted charge, or a partial
   * reversal. Each entry is what an allocation has to resolve.
   */
  @Get('unattributed-depreciation')
  async unattributedDepreciation() {
    // The whole posted ledger, on the same basis the register reports at —
    // an entry dated in the future is no less unattributed for being future.
    return {
      unattributed:
        await this.attribution.unattributedDepreciation('9999-12-31'),
    };
  }

  /**
   * Supply the split of one such voucher across the assets it charged. The
   * allocation is validated against the voucher's signed class legs — exact
   * reconciliation, correct class, no over-allocation, no asset that did not
   * yet exist — and is append-only once written.
   */
  @Post('depreciation-allocations')
  async allocateDepreciation(@Body() dto: DepreciationAllocationDto) {
    return this.attribution.allocate({
      voucherId: dto.voucher_id,
      allocations: dto.allocations.map((a) => ({
        fixedAssetId: a.fixed_asset_id,
        amountMinor: a.amount_minor,
      })),
    });
  }

  @Post(':id/disposal')
  async dispose(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: DisposeAssetDto,
  ) {
    const { depreciationVoucher, disposalVoucher } = await this.service.dispose(
      id,
      dto,
    );
    return { depreciationVoucher, disposalVoucher };
  }
}
