import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';
import { DocumentStorageService } from './document-storage.service';

@Module({
  imports: [DatabaseModule],
  controllers: [DocumentsController],
  providers: [DocumentsService, DocumentStorageService],
  exports: [DocumentsService, DocumentStorageService],
})
export class DocumentsModule {}
