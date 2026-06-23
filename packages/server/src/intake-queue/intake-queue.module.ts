import { Module } from '@nestjs/common';
import { DocumentsModule } from '../documents/documents.module';
import { AiModule } from '../ai/ai.module';
import { IntakeQueueWorker } from './intake-queue.worker';

/**
 * IntakeQueueModule — owns the background worker that serializes intake
 * processing. Depends only on DocumentsModule (claim primitive) and AiModule
 * (the gated intake pipeline); nothing depends back on it, so there is no
 * module cycle.
 */
@Module({
  imports: [DocumentsModule, AiModule],
  providers: [IntakeQueueWorker],
})
export class IntakeQueueModule {}
