import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam, ApiQuery } from '@nestjs/swagger';
import { AuditFindingsService } from './audit-findings.service';
import type {
  AuditFinding,
  CreateAuditFindingDto,
  FindingSeverity,
} from './types';

@ApiTags('audit-findings')
@Controller('api/audit-findings')
export class AuditFindingsController {
  constructor(private readonly auditFindingsService: AuditFindingsService) {}

  @Post()
  @ApiOperation({ summary: 'Create an audit finding', description: 'Record an audit finding.' })
  async create(
    @Body() dto: CreateAuditFindingDto,
  ): Promise<{ finding: AuditFinding }> {
    const finding = await this.auditFindingsService.create(dto);
    return { finding };
  }

  @Get()
  @ApiOperation({ summary: 'List audit findings', description: 'List findings, optionally filtered by severity.' })
  @ApiQuery({ name: 'severity', description: 'Filter by finding severity', required: false })
  async list(
    @Query('severity') severity?: FindingSeverity,
  ): Promise<{ findings: AuditFinding[] }> {
    const findings = await this.auditFindingsService.list(severity);
    return { findings };
  }

  @Post(':id/resolve')
  @ApiOperation({ summary: 'Resolve an audit finding', description: 'Mark a finding resolved.' })
  @ApiParam({ name: 'id', description: 'Finding id' })
  async resolve(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<{ finding: AuditFinding }> {
    const finding = await this.auditFindingsService.resolve(id);
    return { finding };
  }

  @Post(':id/snooze')
  @ApiOperation({ summary: 'Snooze an audit finding', description: 'Snooze a finding until later.' })
  @ApiParam({ name: 'id', description: 'Finding id' })
  async snooze(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<{ finding: AuditFinding }> {
    const finding = await this.auditFindingsService.snooze(id);
    return { finding };
  }
}
