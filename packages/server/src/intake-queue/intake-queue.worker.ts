import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { DocumentsService } from '../documents/documents.service';
import { IntakeWorkflowService } from '../ai/intake-workflow.service';

/** Backstop poll interval (ms). The primary path is the startup drain plus
 *  this poll; processing itself is serialized inside IntakeWorkflowService. */
export const POLL_INTERVAL_MS = 1500;
/** A document in flight longer than this (seconds) is assumed crash-stranded
 *  and may be reclaimed. */
export const STALE_SECONDS = 300;
/** Give up auto-processing a document after this many failed claims so a
 *  poison document cannot block the queue. */
export const MAX_ATTEMPTS = 3;

/**
 * IntakeQueueWorker — drains the durable backlog (documents with
 * status='pending') one document at a time.
 *
 * Single-flight: only one drainLoop runs at a time; a kick() during a drain
 * sets a rerun flag so newly-arrived work is picked up without overlapping
 * loops. Processing is additionally serialized by the ProcessingGate inside
 * IntakeWorkflowService.process, which also guards against the manual triage
 * route running concurrently.
 */
@Injectable()
export class IntakeQueueWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(IntakeQueueWorker.name);
  private draining = false;
  private rerun = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly documents: DocumentsService,
    private readonly workflow: IntakeWorkflowService,
  ) {}

  onModuleInit(): void {
    // Register the reprocess-kick listener FIRST — before the test-env
    // early-return — so a Retry re-queue wakes the worker in every environment
    // (production and e2e), not just when the backstop poll is armed.
    this.documents.setReprocessKicker(() => {
      void this.kick();
    });

    if (process.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => {
      void this.kick();
    }, POLL_INTERVAL_MS);
    // Startup drain: pick up anything left pending (or crash-stranded) while
    // the server was down.
    void this.kick();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Wake the worker. Single-flight: if a drain is running, mark for rerun. */
  kick(): Promise<void> {
    if (this.draining) {
      this.rerun = true;
      return Promise.resolve();
    }
    return this.drainLoop();
  }

  /** Claim-and-process until the queue is drained. */
  async drainLoop(): Promise<void> {
    this.draining = true;
    try {
      do {
        this.rerun = false;
        let claimed: { id: number; claimant_id: number | null } | null;
        while (
          (claimed = await this.documents.claimNextPending(
            STALE_SECONDS,
            MAX_ATTEMPTS,
          )) !== null
        ) {
          try {
            this.logger.debug(
              `drainLoop: processing claimed document ${claimed.id}`,
            );
            await this.workflow.process(claimed.id, claimed.claimant_id);
          } catch (err) {
            // process()'s own finally cleared processing_since; the attempt
            // counter (bumped at claim) bounds retries. Log and move on — one
            // bad document must not stop the queue.
            this.logger.error(
              `Intake processing failed for document ${claimed.id}: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
        }
      } while (this.rerun);
    } finally {
      this.draining = false;
    }
  }
}
