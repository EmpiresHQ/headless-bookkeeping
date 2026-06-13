import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  ParseIntPipe,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ReportingPeriodsService } from './reporting-periods.service';
import { CreateReportingPeriodDto, CreateNextPeriodDto } from './types';
import type { ReportingPeriod, PeriodWarning } from './types';

@ApiTags('reporting-periods')
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

  @Post('next')
  async createNext(@Body() dto: CreateNextPeriodDto): Promise<ReportingPeriod> {
    return this.service.createNext(dto);
  }

  @Post(':id/lock')
  async lock(@Param('id', ParseIntPipe) id: number): Promise<ReportingPeriod> {
    return this.service.lock(id);
  }

  @Get(':id/warnings')
  async getWarnings(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<{ warnings: PeriodWarning[] }> {
    const warnings = await this.service.getWarnings(id);
    return { warnings };
  }
}
