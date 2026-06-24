import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';
import { DocumentStorageService } from './document-storage.service';
import { PreviewRenderer } from './preview-renderer';
import { HeicDecoder } from '../triage/heic-decoder';

@Module({
  imports: [DatabaseModule],
  controllers: [DocumentsController],
  providers: [DocumentsService, DocumentStorageService, HeicDecoder, PreviewRenderer],
  exports: [DocumentsService, DocumentStorageService, PreviewRenderer],
})
export class DocumentsModule {}
