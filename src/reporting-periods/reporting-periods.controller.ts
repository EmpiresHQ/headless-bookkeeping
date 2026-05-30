import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  ParseIntPipe,
} from '@nestjs/common';
import { ReportingPeriodsService } from './reporting-periods.service';
import type { ReportingPeriod, CreateReportingPeriodDto } from './types';

@Controller('api/reporting-periods')
export class ReportingPeriodsController {
  constructor(private readonly service: ReportingPeriodsService) {}

  @Get()
  async list(): Promise<{ reportingPeriods: ReportingPeriod[] }> {
    const reportingPeriods = await this.service.list();
    return { reportingPeriods };
  }

  @Get('current')
  async getCurrent(): Promise<ReportingPeriod> {
    return this.service.getCurrent();
  }

  @Get(':id')
  async getById(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<ReportingPeriod> {
    return this.service.getById(id);
  }

  @Post()
  async create(
    @Body() dto: CreateReportingPeriodDto,
  ): Promise<ReportingPeriod> {
    return this.service.create(dto);
  }
}
