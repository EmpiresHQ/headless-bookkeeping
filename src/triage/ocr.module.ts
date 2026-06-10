import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { DocumentsModule } from '../documents/documents.module';
import { ConversationsModule } from '../conversations/conversations.module';
import { OcrService } from './ocr.service';
import { DocumentTranscriber } from './document-transcriber.port';
import { DoclingTranscriber } from './docling-transcriber';

/**
 * OcrModule — provides OcrService (Pass 1 OCR transcription) and binds the
 * DocumentTranscriber port to its real adapter (DoclingTranscriber → docling-serve).
 *
 * Extracted from TriageModule to break the circular dependency:
 * AiModule → TriageModule → AiModule.
 *
 * AiModule imports OcrModule (for IntakeWorkflowService → OcrService).
 * TriageModule imports AiModule (for IntakeWorkflowService) + OcrModule.
 */
@Module({
  imports: [DatabaseModule, DocumentsModule, ConversationsModule],
  providers: [
    OcrService,
    { provide: DocumentTranscriber, useClass: DoclingTranscriber },
  ],
  exports: [OcrService],
})
export class OcrModule {}
