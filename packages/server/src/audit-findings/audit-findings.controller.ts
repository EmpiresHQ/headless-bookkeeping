import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
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
  async create(
    @Body() dto: CreateAuditFindingDto,
  ): Promise<{ finding: AuditFinding }> {
    const finding = await this.auditFindingsService.create(dto);
    return { finding };
  }

  @Get()
  async list(
    @Query('severity') severity?: FindingSeverity,
  ): Promise<{ findings: AuditFinding[] }> {
    const findings = await this.auditFindingsService.list(severity);
    return { findings };
  }

  @Post(':id/resolve')
  async resolve(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<{ finding: AuditFinding }> {
    const finding = await this.auditFindingsService.resolve(id);
    return { finding };
  }

  @Post(':id/snooze')
  async snooze(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<{ finding: AuditFinding }> {
    const finding = await this.auditFindingsService.snooze(id);
    return { finding };
  }
}
