import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Res,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import type { Response } from 'express';
import { DocumentsService } from './documents.service';
import { Document, DocumentWithSources } from './types';

@ApiTags('documents')
@Controller('api/documents')
export class DocumentsController {
  constructor(private readonly documentsService: DocumentsService) {}

  @Post()
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
    }),
  )
  @HttpCode(HttpStatus.CREATED)
  async uploadDocument(
    @UploadedFile() file: Express.Multer.File,
  ): Promise<{ document: Document; deduplicated: boolean }> {
    const result = await this.documentsService.upload({
      buffer: file.buffer,
      filename: file.originalname,
      mimeType: file.mimetype,
      channel: 'upload',
      sourceIdentifier: null,
    });

    if (result.deduplicated) {
      return { document: result.document, deduplicated: true };
    }

    return { document: result.document, deduplicated: false };
  }

  @Get()
  async listDocuments(): Promise<{ documents: Document[] }> {
    return { documents: await this.documentsService.list() };
  }

  @Get(':id')
  async getDocument(@Param('id') id: string): Promise<DocumentWithSources> {
    const doc = await this.documentsService.getById(Number(id));
    return this.documentsService.hydrate(doc);
  }

  /** Download the raw stored bytes of a document (D4). */
  @Get(':id/file')
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
  async deleteDocument(@Param('id') id: string): Promise<{ deleted: number }> {
    await this.documentsService.deleteDocument(Number(id));
    return { deleted: Number(id) };
  }
}
