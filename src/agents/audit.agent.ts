import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

/**
 * AuditAgent — stub with scheduled sweep.
 *
 * Role: periodically scan the ledger for attention items (missing receipts,
 * upcoming deadlines, anomalies) and persist them as AuditFindings.
 * The SecretaryAgent reads these findings and nags users based on severity.
 *
 * In v1 the scheduled sweep is a NO-OP — it must NOT fabricate findings on a
 * live schedule (an hourly INSERT would flood audit_finding). Real detection
 * (idempotent upsert by the finding natural key) lands later; demo findings
 * come only from a seed/fixture, never the cron.
 * Cron: every hour (0 * * * *).
 */
@Injectable()
export class AuditAgent {
  private readonly logger = new Logger(AuditAgent.name);

  /**
   * Scheduled sweep — runs every hour via @Cron. No-op in v1 (see class doc):
   * it writes nothing so it cannot duplicate findings. When real detection is
   * implemented it must upsert by (finding_type, referenced_object_type,
   * referenced_object_id), never blind-insert.
   */
  @Cron('0 * * * *')
  sweep(): void {
    this.logger.log('AuditAgent sweep: no-op (detection not yet implemented)');
  }
}
