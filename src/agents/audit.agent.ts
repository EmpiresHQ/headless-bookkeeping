import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { AuditFindingsService } from '../audit-findings/audit-findings.service';

/**
 * AuditAgent — stub with scheduled sweep.
 *
 * Role: periodically scan the ledger for attention items (missing receipts,
 * upcoming deadlines, anomalies) and persist them as AuditFindings.
 * The SecretaryAgent reads these findings and nags users based on severity.
 *
 * In v1: sweep() creates a sample finding on each run.
 * Cron: every hour (0 * * * *).
 */
@Injectable()
export class AuditAgent {
  private readonly logger = new Logger(AuditAgent.name);

  constructor(private readonly auditFindingsService: AuditFindingsService) {}

  /**
   * Scheduled sweep — runs every hour via @Cron.
   * Creates sample AuditFindings for demonstration.
   */
  @Cron('0 * * * *')
  async sweep(): Promise<void> {
    this.logger.log('AuditAgent sweep started');

    // Sample finding: missing receipt reminder
    await this.auditFindingsService.create({
      finding_type: 'missing_receipt',
      severity: 'medium',
      description:
        'Sample finding: expense without receipt — attach supporting document',
      referenced_object_type: 'expense',
      referenced_object_id: 1,
    });

    this.logger.log('AuditAgent sweep completed — 1 sample finding created');
  }
}
