import { Controller, Get, Post, Param, Body, ParseIntPipe } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { StatutorySubmissionService } from './statutory-submission.service';
import { RecordSubmissionEventDto } from './types';
import type { SubmissionEvent, SubmissionState } from './types';

@ApiTags('statutory-submission')
@Controller('api/reporting-periods')
export class StatutorySubmissionController {
  constructor(private readonly service: StatutorySubmissionService) {}

  @Post(':id/submission-events')
  async recordEvent(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: RecordSubmissionEventDto,
  ): Promise<SubmissionEvent> {
    return this.service.recordOperatorEvent(id, dto);
  }

  @Get(':id/submission-state')
  async getState(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<SubmissionState> {
    return this.service.getState(id);
  }
}
