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
import { DisposeAssetDto } from './types';

@ApiTags('fixed-assets')
@Controller('api/fixed-assets')
export class FixedAssetsController {
  constructor(private readonly service: FixedAssetsService) {}

  @Get()
  async list() {
    return { fixedAssets: await this.service.list() };
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
