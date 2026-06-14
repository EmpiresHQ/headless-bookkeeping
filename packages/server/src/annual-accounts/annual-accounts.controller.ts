import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Res,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { AnnualAccountsService } from './annual-accounts.service';
import { FinalizeAnnualAccountsDto } from './types';
import type { AnnualAccountsResult } from '../plugins/annual-accounts.types';

@ApiTags('annual-accounts')
@Controller('api/reporting-periods')
export class AnnualAccountsController {
  constructor(private readonly service: AnnualAccountsService) {}

  /**
   * Draft annual accounts — side-effect-free. Returns the RIK-XBRL file. The
   * operator uploads it to the portal for authoritative validation.
   */
  @Get(':id/annual-accounts')
  async download(
    @Param('id', ParseIntPipe) id: number,
    @Res() res: Response,
  ): Promise<void> {
    const { artifacts } = await this.service.generate(id);
    if (artifacts.length === 0) {
      throw new BadRequestException('No annual-accounts artifacts produced');
    }
    const a = artifacts[0];
    res.setHeader('Content-Type', a.mimeType);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${a.filename}"`,
    );
    res.send(a.content);
  }

  /**
   * Finalize the year — posts the annual depreciation charge, locks the year,
   * and returns the authoritative artifacts + warnings. One-shot.
   */
  @Post(':id/annual-accounts/finalize')
  async finalize(
    @Param('id', ParseIntPipe) id: number,
    @Body() _dto: FinalizeAnnualAccountsDto,
  ): Promise<AnnualAccountsResult> {
    return this.service.finalize(id);
  }
}
