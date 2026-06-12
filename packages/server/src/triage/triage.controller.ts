import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { TriageService } from './triage.service';
import { DocumentsService } from '../documents/documents.service';
import {
  TriageOutcome,
  DocumentDebug,
  ManualClassifyDto,
  PendingDraft,
  ResolveSupplierDto,
  NeedsTriageItem,
} from './types';

@ApiTags('triage')
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

  @Get('api/documents/:id/debug')
  async debugDocument(@Param('id') id: string): Promise<DocumentDebug> {
    return this.triageService.debug(Number(id));
  }

  @Get('api/triage/needs-triage')
  async getNeedsTriageItems(): Promise<{ items: NeedsTriageItem[] }> {
    const items = await this.triageService.getNeedsTriageItems();
    return { items };
  }

  @Get('api/triage/pending')
  async getPending() {
    const all = await this.documentsService.list();
    const pending = all.filter((d) => d.status === 'pending');
    return { pending };
  }

  @Get('api/documents/:id/pending-draft')
  async pendingDraft(@Param('id') id: string): Promise<PendingDraft> {
    return this.triageService.getPendingDraft(Number(id));
  }

  @Post('api/documents/:id/resolve-supplier')
  async resolveSupplier(
    @Param('id') id: string,
    @Body() dto: ResolveSupplierDto,
  ): Promise<TriageOutcome> {
    return this.triageService.resolveSupplier(
      Number(id),
      dto.supplier_entity_id,
    );
  }

  @Post('api/documents/:id/manual-classify')
  async manualClassify(
    @Param('id') id: string,
    @Body() dto: ManualClassifyDto,
  ): Promise<TriageOutcome> {
    return this.triageService.manualClassify(Number(id), dto);
  }

  @Post('api/documents/:id/complete')
  @HttpCode(HttpStatus.CREATED)
  async completeDocument(@Param('id') id: string) {
    await this.documentsService.setStatus(Number(id), 'processed');
    await this.documentsService.setPendingTriageResult(Number(id), null);
    return { id: Number(id), status: 'processed' };
  }
}
