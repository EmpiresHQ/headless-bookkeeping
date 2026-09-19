import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  ParseIntPipe,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiParam,
  ApiOkResponse,
} from '@nestjs/swagger';
import { ReportingPeriodsService } from './reporting-periods.service';
import { CreateReportingPeriodDto, CreateNextPeriodDto } from './types';
import type {
  ReportingPeriod,
  PeriodWarning,
  FilingReconciliation,
} from './types';
import {
  reportingPeriodResponseSchema,
  reportingPeriodsListResponseSchema,
} from '../openapi-response-schemas';

@ApiTags('reporting-periods')
@Controller('api/reporting-periods')
export class ReportingPeriodsController {
  constructor(private readonly service: ReportingPeriodsService) {}

  @Get()
  @ApiOperation({
    summary: 'List reporting periods',
    description: 'Return all reporting periods.',
  })
  @ApiOkResponse({ schema: reportingPeriodsListResponseSchema })
  async list(): Promise<{ reportingPeriods: ReportingPeriod[] }> {
    const reportingPeriods = await this.service.list();
    return { reportingPeriods };
  }

  @Get('current')
  @ApiOperation({
    summary: 'Get the current reporting period',
    description: 'Return the currently open period.',
  })
  async getCurrent(): Promise<ReportingPeriod> {
    return this.service.getCurrent();
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get a reporting period by id',
    description: 'Fetch a single period.',
  })
  @ApiParam({ name: 'id', description: 'Reporting period id' })
  @ApiOkResponse({ schema: reportingPeriodResponseSchema })
  async getById(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<ReportingPeriod> {
    return this.service.getById(id);
  }

  @Post()
  @ApiOperation({
    summary: 'Create a reporting period',
    description: 'Create a new reporting period.',
  })
  async create(
    @Body() dto: CreateReportingPeriodDto,
  ): Promise<ReportingPeriod> {
    return this.service.create(dto);
  }

  @Post('next')
  @ApiOperation({
    summary: 'Open the next reporting period',
    description: 'Advance to and open the next period.',
  })
  async createNext(@Body() dto: CreateNextPeriodDto): Promise<ReportingPeriod> {
    return this.service.createNext(dto);
  }

  @Post(':id/lock')
  @ApiOperation({
    summary: 'Lock a reporting period',
    description: 'Lock a period; further postings into it are rejected.',
  })
  @ApiParam({ name: 'id', description: 'Reporting period id' })
  async lock(@Param('id', ParseIntPipe) id: number): Promise<ReportingPeriod> {
    return this.service.lock(id);
  }

  @Post(':id/filing/reconcile')
  @ApiOperation({
    summary: "Reconcile a locked period's filing state",
    description:
      'Repair a LOCKED period bound to a stale or incomplete filing state — ' +
      'the supported correction path for periods filed before the draft-export ' +
      'freeze bug was fixed. Never unlocks and never edits or deletes anything: ' +
      'it appends a complete VAT snapshot (if the bound one no longer describes ' +
      "the period's posted vouchers), appends a frozen filing payload version, " +
      'and appends a `prepared` submission event pinning both. Earlier snapshots ' +
      'and payload versions stay addressable, so what was already submitted ' +
      'remains exactly reproducible. Idempotent: a healthy period writes nothing ' +
      'and returns changed=false. It does not file anything with the tax ' +
      'authority — an already-submitted period needs a parandusdeklaratsioon.',
  })
  @ApiParam({ name: 'id', description: 'Reporting period id' })
  async reconcileFiling(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<FilingReconciliation> {
    return this.service.reconcileFilingSnapshot(id);
  }

  @Get(':id/warnings')
  @ApiOperation({
    summary: 'Get period close warnings',
    description: 'Return soft warnings blocking a clean close.',
  })
  @ApiParam({ name: 'id', description: 'Reporting period id' })
  async getWarnings(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<{ warnings: PeriodWarning[] }> {
    const warnings = await this.service.getWarnings(id);
    return { warnings };
  }
}
