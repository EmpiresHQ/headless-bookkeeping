import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam } from '@nestjs/swagger';
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
  @ApiOperation({ summary: 'Triage a document', description: 'Run triage on an inbound document to classify it.' })
  @ApiParam({ name: 'id', description: 'Document id' })
  async triageDocument(@Param('id') id: string): Promise<TriageOutcome> {
    return this.triageService.route(Number(id));
  }

  @Get('api/documents/:id/debug')
  @ApiOperation({ summary: 'Debug a document\'s triage', description: 'Return triage debug detail for a document.' })
  @ApiParam({ name: 'id', description: 'Document id' })
  async debugDocument(@Param('id') id: string): Promise<DocumentDebug> {
    return this.triageService.debug(Number(id));
  }

  @Get('api/triage/needs-triage')
  @ApiOperation({ summary: 'List items needing triage', description: 'List structured triage items awaiting an action (the needs-triage queue).' })
  async getNeedsTriageItems(): Promise<{ items: NeedsTriageItem[] }> {
    const items = await this.triageService.getNeedsTriageItems();
    return { items };
  }

  @Get('api/triage/pending')
  @ApiOperation({ summary: 'List pending documents', description: "List raw documents with status 'pending' (not yet triaged)." })
  async getPending() {
    const all = await this.documentsService.list();
    const pending = all.filter((d) => d.status === 'pending');
    return { pending };
  }

  @Get('api/documents/:id/pending-draft')
  @ApiOperation({ summary: 'Get a document\'s pending draft', description: 'Return the pending draft for a document.' })
  @ApiParam({ name: 'id', description: 'Document id' })
  async pendingDraft(@Param('id') id: string): Promise<PendingDraft> {
    return this.triageService.getPendingDraft(Number(id));
  }

  @Post('api/documents/:id/resolve-supplier')
  @ApiOperation({ summary: 'Resolve a document\'s supplier', description: 'Attach/resolve the supplier for a triaged document.' })
  @ApiParam({ name: 'id', description: 'Document id' })
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
  @ApiOperation({ summary: 'Manually classify a document', description: 'Override automatic triage and manually classify a document.' })
  @ApiParam({ name: 'id', description: 'Document id' })
  async manualClassify(
    @Param('id') id: string,
    @Body() dto: ManualClassifyDto,
  ): Promise<TriageOutcome> {
    return this.triageService.manualClassify(Number(id), dto);
  }

  @Post('api/documents/:id/complete')
  @ApiOperation({ summary: 'Complete a document\'s triage', description: 'Finalize triage and produce a postable item.' })
  @ApiParam({ name: 'id', description: 'Document id' })
  @HttpCode(HttpStatus.CREATED)
  async completeDocument(@Param('id') id: string) {
    await this.documentsService.setStatus(Number(id), 'processed');
    await this.documentsService.setPendingTriageResult(Number(id), null);
    return { id: Number(id), status: 'processed' };
  }
}
