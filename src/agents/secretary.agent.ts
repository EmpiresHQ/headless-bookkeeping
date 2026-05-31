import { Injectable, Logger } from '@nestjs/common';
import { AuditFindingsService } from '../audit-findings/audit-findings.service';
import { AuditFinding } from '../audit-findings/types';

/**
 * SecretaryAgent — stub with notify.
 *
 * Role: the only proactive, user-facing agent. Reads open AuditFindings
 * and nags users via Telegram/Slack/email at a cadence driven by each
 * finding's severity (low → ~daily, high → ~hourly).
 *
 * In v1: notify() logs open findings to console — no external channel calls.
 * Working-hours gating and anti-spam discipline are deferred.
 */
@Injectable()
export class SecretaryAgent {
  private readonly logger = new Logger(SecretaryAgent.name);

  constructor(private readonly auditFindingsService: AuditFindingsService) {}

  /**
   * Notify — reads open findings and logs them.
   * In v1 this is a stub: no external calls, console-only.
   */
  async notify(): Promise<void> {
    const findings: AuditFinding[] =
      await this.auditFindingsService.getOpenFindings();

    if (findings.length === 0) {
      this.logger.log('SecretaryAgent: no open findings');
      return;
    }

    this.logger.log(
      `SecretaryAgent: ${findings.length} open finding(s) to notify`,
    );
    for (const finding of findings) {
      this.logger.log(
        `  [${finding.severity.toUpperCase()}] ${finding.finding_type}: ${finding.description}`,
      );
    }
  }
}
