import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { DocumentsModule } from '../documents/documents.module';
import { ConversationsModule } from '../conversations/conversations.module';
import { OcrService } from './ocr.service';

/**
 * OcrModule — provides OcrService (Pass 1 OCR transcription).
 *
 * Extracted from TriageModule to break the circular dependency:
 * AiModule → TriageModule → AiModule.
 *
 * AiModule imports OcrModule (for IntakeWorkflowService → OcrService).
 * TriageModule imports AiModule (for IntakeWorkflowService) + OcrModule.
 */
@Module({
  imports: [DatabaseModule, DocumentsModule, ConversationsModule],
  providers: [OcrService],
  exports: [OcrService],
})
export class OcrModule {}
