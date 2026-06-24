import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { DocumentsModule } from '../documents/documents.module';
import { ConversationsModule } from '../conversations/conversations.module';
import { AgentConfigModule } from '../ai/agent-config.module';
import { OcrService } from './ocr.service';
import { DocumentTranscriber } from './document-transcriber.port';
import { MimeRoutingTranscriber } from './mime-routing-transcriber';
import { LlmVisionTranscriber } from './llm-vision-transcriber';
import { PdfTextExtractor } from './pdf-text-extractor';
import { PdfRasterizer } from './pdf-rasterizer';
import { HeicDecoder } from './heic-decoder';
import { ImageScaler } from './image-scaler';

/**
 * OcrModule — provides OcrService (Pass 1) and binds the DocumentTranscriber
 * port to the mime-routing engine (ADR-0032): in-process pdf-parse text
 * extraction for born-digital PDFs, external vision OCR (LiteLLM/dots.ocr) for
 * images and scanned PDFs (rasterised via poppler).
 *
 * Extracted from TriageModule to break the circular dependency:
 * AiModule → TriageModule → AiModule.
 */
@Module({
  imports: [
    DatabaseModule,
    DocumentsModule,
    ConversationsModule,
    AgentConfigModule,
  ],
  providers: [
    OcrService,
    LlmVisionTranscriber,
    PdfTextExtractor,
    PdfRasterizer,
    HeicDecoder,
    ImageScaler,
    { provide: DocumentTranscriber, useClass: MimeRoutingTranscriber },
  ],
  exports: [OcrService],
})
export class OcrModule {}
