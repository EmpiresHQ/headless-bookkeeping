import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Query,
  Body,
  Res,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
  HttpCode,
  HttpStatus,
  BadRequestException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiParam,
  ApiConsumes,
  ApiBody,
  ApiOkResponse,
} from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import type { Response } from 'express';
import { DocumentsService } from './documents.service';
import { DocumentUrlSignerService } from './document-url-signer.service';
import { Public } from '../auth/api-token.guard';
import {
  Document,
  DocumentArchiveRow,
  DocumentWithSources,
  Channel,
} from './types';
import {
  documentWithSourcesResponseSchema,
  documentsListResponseSchema,
} from '../openapi-response-schemas';

@ApiTags('documents')
@Controller('api/documents')
export class DocumentsController {
  constructor(
    private readonly documentsService: DocumentsService,
    private readonly urlSigner: DocumentUrlSignerService,
  ) {}

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
    description:
      'Return all source documents enriched with linked expense, triage reason, and latest channel.',
  })
  @ApiOkResponse({ schema: documentsListResponseSchema })
  async listDocuments(): Promise<{ documents: DocumentArchiveRow[] }> {
    return { documents: await this.documentsService.listArchiveRows() };
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get a document by id',
    description: 'Fetch a document with its sources.',
  })
  @ApiParam({ name: 'id', description: 'Document id' })
  @ApiOkResponse({ schema: documentWithSourcesResponseSchema })
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
   * Mint a short-lived, signed URL for a document's file. Bearer-protected (the
   * caller must already be an authenticated operator) — it hands back a
   * token-free link the browser can open directly or the operator can copy and
   * share. The link points at the @Public `/shared` route and self-expires.
   */
  @Get(':id/signed-url')
  @ApiOperation({
    summary: 'Mint a signed, shareable URL for a document file',
    description:
      'Returns a short-lived URL that streams the file without an API token (valid ~1h).',
  })
  @ApiParam({ name: 'id', description: 'Document id' })
  async getSignedUrl(@Param('id') id: string): Promise<{ url: string }> {
    // Touch the document so a missing id 404s here (Bearer side) rather than
    // minting a link to nothing.
    await this.documentsService.getById(Number(id));
    return { url: await this.urlSigner.buildSharedUrl(Number(id)) };
  }

  /**
   * Stream a document's file via a signed URL — NO API token required. The
   * `exp`/`sig` query params (minted by {@link getSignedUrl}) authorize this one
   * document for a bounded window; an absent, tampered, or expired signature is
   * rejected. This is the only token-free path to document bytes.
   */
  @Public()
  @Get(':id/shared')
  @ApiOperation({
    summary: "Download a document's file via a signed URL",
    description:
      'Streams the file when the exp/sig signature is valid and unexpired. No API token.',
  })
  @ApiParam({ name: 'id', description: 'Document id' })
  async getSharedDocumentFile(
    @Param('id') id: string,
    @Query('exp') exp: string,
    @Query('sig') sig: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const ok = await this.urlSigner.verify(Number(id), Number(exp), sig);
    if (!ok) {
      throw new UnauthorizedException('Invalid or expired document link');
    }
    const { buffer, filename, mimeType } = await this.documentsService.getFile(
      Number(id),
    );
    res.set({
      'Content-Type': mimeType,
      'Content-Disposition': `inline; filename="${filename}"`,
    });
    return new StreamableFile(buffer);
  }

  /**
   * Stream the thumbnail PNG for a document.
   *
   * If `preview_path` is NULL (pre-existing or render-failed doc), renders
   * once via PreviewRenderer, persists the path, then streams — so old
   * documents self-heal on first view with no backfill job.
   *
   * Returns 404 for non-visual files (render → null) or missing docs.
   * Sets ETag = document hash so the browser caches across reloads.
   */
  @Get(':id/preview')
  @ApiOperation({
    summary: "Stream a document's thumbnail PNG",
    description:
      'Returns a ~256px PNG thumbnail. Renders lazily on first request if not yet cached.',
  })
  @ApiParam({ name: 'id', description: 'Document id' })
  async getDocumentPreview(
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { buffer, hash } = await this.documentsService.getPreview(Number(id));
    res.set({
      'Content-Type': 'image/png',
      ETag: `"${hash}"`,
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
