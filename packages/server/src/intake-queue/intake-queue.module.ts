import { Module } from '@nestjs/common';
import { DocumentsModule } from '../documents/documents.module';
import { AiModule } from '../ai/ai.module';
import { IntakeQueueWorker } from './intake-queue.worker';

/**
 * IntakeQueueModule — owns the background worker that serializes intake
 * processing. Depends only on DocumentsModule (claim primitive) and AiModule
 * (the gated intake pipeline); nothing depends back on it, so there is no
 * module cycle. The worker registers a reprocess-kick listener on
 * DocumentsService at init, so a Retry re-queue wakes it without inverting the
 * module dependency direction.
 */
@Module({
  imports: [DocumentsModule, AiModule],
  providers: [IntakeQueueWorker],
  exports: [IntakeQueueWorker],
})
export class IntakeQueueModule {}
