import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  ParseIntPipe,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam } from '@nestjs/swagger';
import { ReportingPeriodsService } from './reporting-periods.service';
import { CreateReportingPeriodDto, CreateNextPeriodDto } from './types';
import type { ReportingPeriod, PeriodWarning } from './types';

@ApiTags('reporting-periods')
@Controller('api/reporting-periods')
export class ReportingPeriodsController {
  constructor(private readonly service: ReportingPeriodsService) {}

  @Get()
  @ApiOperation({ summary: 'List reporting periods', description: 'Return all reporting periods.' })
  async list(): Promise<{ reportingPeriods: ReportingPeriod[] }> {
    const reportingPeriods = await this.service.list();
    return { reportingPeriods };
  }

  @Get('current')
  @ApiOperation({ summary: 'Get the current reporting period', description: 'Return the currently open period.' })
  async getCurrent(): Promise<ReportingPeriod> {
    return this.service.getCurrent();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a reporting period by id', description: 'Fetch a single period.' })
  @ApiParam({ name: 'id', description: 'Reporting period id' })
  async getById(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<ReportingPeriod> {
    return this.service.getById(id);
  }

  @Post()
  @ApiOperation({ summary: 'Create a reporting period', description: 'Create a new reporting period.' })
  async create(
    @Body() dto: CreateReportingPeriodDto,
  ): Promise<ReportingPeriod> {
    return this.service.create(dto);
  }

  @Post('next')
  @ApiOperation({ summary: 'Open the next reporting period', description: 'Advance to and open the next period.' })
  async createNext(
    @Body() dto: CreateNextPeriodDto,
  ): Promise<ReportingPeriod> {
    return this.service.createNext(dto);
  }

  @Post(':id/lock')
  @ApiOperation({ summary: 'Lock a reporting period', description: 'Lock a period; further postings into it are rejected.' })
  @ApiParam({ name: 'id', description: 'Reporting period id' })
  async lock(@Param('id', ParseIntPipe) id: number): Promise<ReportingPeriod> {
    return this.service.lock(id);
  }

  @Get(':id/warnings')
  @ApiOperation({ summary: 'Get period close warnings', description: 'Return soft warnings blocking a clean close.' })
  @ApiParam({ name: 'id', description: 'Reporting period id' })
  async getWarnings(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<{ warnings: PeriodWarning[] }> {
    const warnings = await this.service.getWarnings(id);
    return { warnings };
  }
}
