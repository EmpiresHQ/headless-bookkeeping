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
}
