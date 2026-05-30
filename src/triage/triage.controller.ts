import {
  Controller,
  Get,
  Post,
  Param,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { TriageService } from './triage.service';
import { DocumentsService } from '../documents/documents.service';
import { TriageOutcome } from './types';

@Controller()
export class TriageController {
  constructor(
    private readonly triageService: TriageService,
    private readonly documentsService: DocumentsService,
  ) {}

  @Post('api/documents/:id/triage')
  async triageDocument(@Param('id') id: string): Promise<TriageOutcome> {
    return this.triageService.route(Number(id));
  }

  @Get('api/triage/pending')
  async getPending() {
    const all = await this.documentsService.list();
    const pending = all.filter((d) => d.status === 'pending');
    return { pending };
  }

  @Post('api/documents/:id/complete')
  @HttpCode(HttpStatus.CREATED)
  async completeDocument(@Param('id') id: string) {
    await this.documentsService.setStatus(Number(id), 'processed');
    return { id: Number(id), status: 'processed' };
  }
}
