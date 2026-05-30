import {
  Controller,
  Get,
  Post,
  Param,
  UploadedFile,
  UseInterceptors,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { DocumentsService } from './documents.service';
import { Document, DocumentWithSources } from './types';

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
}
