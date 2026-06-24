import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Body,
  Res,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
  HttpCode,
  HttpStatus,
  BadRequestException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiParam,
  ApiConsumes,
  ApiBody,
} from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import type { Response } from 'express';
import { DocumentsService } from './documents.service';
import { Document, DocumentWithSources, Channel } from './types';

@ApiTags('documents')
@Controller('api/documents')
export class DocumentsController {
  constructor(private readonly documentsService: DocumentsService) {}

  @Post()
  @ApiOperation({
    summary: 'Upload a document',
    description: 'Upload a source document (multipart file).',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: {
          type: 'string',
          format: 'binary',
          description: 'The document file to upload',
        },
      },
    },
  })
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
    }),
  )
  @HttpCode(HttpStatus.CREATED)
  async uploadDocument(
    @UploadedFile() file: Express.Multer.File,
    @Body()
    body: {
      channel?: string;
      assetLocalId?: string;
      capturedAt?: string;
      precheck?: string;
      claimant_id?: string; // multipart form sends strings
    },
  ): Promise<{ document: Document; deduplicated: boolean }> {
    let precheckJson: string | null = null;
    if (body.precheck !== undefined && body.precheck !== '') {
      try {
        JSON.parse(body.precheck);
      } catch {
        throw new BadRequestException('precheck must be valid JSON');
      }
      precheckJson = body.precheck;
    }

    let capturedAt: number | null = null;
    if (body.capturedAt !== undefined && body.capturedAt !== '') {
      const parsed = Date.parse(body.capturedAt);
      if (Number.isNaN(parsed)) {
        throw new BadRequestException('capturedAt must be an ISO-8601 date');
      }
      capturedAt = Math.floor(parsed / 1000);
    }

    const result = await this.documentsService.upload({
      buffer: file.buffer,
      filename: file.originalname,
      mimeType: file.mimetype,
      channel: (body.channel as Channel) ?? 'upload',
      sourceIdentifier: body.assetLocalId ?? null,
      capturedAt,
      precheckJson,
      claimantId: body.claimant_id ? Number(body.claimant_id) : null,
    });

    return { document: result.document, deduplicated: result.deduplicated };
  }

  @Get()
  @ApiOperation({
    summary: 'List documents',
    description: 'Return all source documents.',
  })
  async listDocuments(): Promise<{ documents: Document[] }> {
    return { documents: await this.documentsService.list() };
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get a document by id',
    description: 'Fetch a document with its sources.',
  })
  @ApiParam({ name: 'id', description: 'Document id' })
  async getDocument(@Param('id') id: string): Promise<DocumentWithSources> {
    const doc = await this.documentsService.getById(Number(id));
    return this.documentsService.hydrate(doc);
  }

  /** Download the raw stored bytes of a document (D4). */
  @Get(':id/file')
  @ApiOperation({
    summary: "Download a document's file",
    description: 'Stream the raw file for a document.',
  })
  @ApiParam({ name: 'id', description: 'Document id' })
  async getDocumentFile(
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { buffer, filename, mimeType } = await this.documentsService.getFile(
      Number(id),
    );
    res.set({
      'Content-Type': mimeType,
      'Content-Disposition': `attachment; filename="${filename}"`,
    });
    return new StreamableFile(buffer);
  }

  /**
   * Approver action: confirm whether the Claimant paid this document from
   * their own funds. Only reachable by API token holders (operators/approvers
   * via the SPA); Claimants interact via Telegram/email and never hold an
   * API token (ADR-0016).
   *
   * paid_by_claimant=true  → Expense will be posted to Cr CLAIMANT_PAYABLE
   * paid_by_claimant=false → claimant_id cleared; Expense posts to Cr AP
   */
  @Post(':id/confirm-payment')
  @ApiOperation({
    summary: 'Confirm whether the claimant paid out of pocket',
    description:
      'Approver action point: sets or clears claimant_id based on payment confirmation.',
  })
  @ApiParam({ name: 'id', description: 'Document id' })
  @HttpCode(HttpStatus.NO_CONTENT)
  async confirmPayment(
    @Param('id') id: string,
    @Body() body: { paid_by_claimant: boolean },
  ): Promise<void> {
    await this.documentsService.confirmPayment(
      Number(id),
      body.paid_by_claimant,
    );
  }

  @Delete(':id')
  @ApiOperation({
    summary: 'Delete a document',
    description: 'Delete a source document.',
  })
  @ApiParam({ name: 'id', description: 'Document id' })
  async deleteDocument(@Param('id') id: string): Promise<{ deleted: number }> {
    await this.documentsService.deleteDocument(Number(id));
    return { deleted: Number(id) };
  }

  /**
   * Reset a `needs_triage` document back to `pending` so the intake queue
   * picks it up for a fresh OCR + classification run.  Idempotent — a
   * no-op when the document is not in `needs_triage`.
   */
  @Post(':id/retry')
  @ApiOperation({
    summary: 'Re-queue a triage-failed document for reprocessing',
    description:
      'Resets a needs_triage document to pending so the intake queue re-picks it.',
  })
  @ApiParam({ name: 'id', description: 'Document id' })
  @HttpCode(HttpStatus.OK)
  async retryDocument(@Param('id') id: string): Promise<{ ok: true }> {
    await this.documentsService.reprocessDocument(Number(id));
    return { ok: true };
  }
}
