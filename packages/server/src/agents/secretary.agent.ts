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
 *
 * The deepened AuditFinding buffer now carries a typed `finding_type`, so the
 * SecretaryAgent branches its nag behavior PER KIND instead of flattening
 * every finding into one identical line. The nag copy stays simple in v1, but
 * the branch point exists and is driven by the typed kind — a needs_triage,
 * a policy hold, and a missing-receipt finding now get distinct phrasing /
 * call-to-action.
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
      const nag = this.nagFor(finding);
      this.logger.log(`  [${finding.severity.toUpperCase()}] ${nag}`);
    }
  }

  /**
   * Per-kind nag copy. The BRANCH POINT is driven entirely by the typed
   * `finding_type`: each known kind gets its own phrasing / call-to-action.
   * A default arm covers any kind not yet given bespoke copy so adding a new
   * FindingType is non-breaking.
   */
  nagFor(finding: AuditFinding): string {
    const ref = finding.referenced_object_id
      ? ` (${finding.referenced_object_type ?? 'object'} #${finding.referenced_object_id})`
      : '';

    switch (finding.finding_type) {
      case 'needs_triage':
        return `Please triage: ${finding.description}${ref}`;
      case 'missing_receipt':
        return `Missing receipt — upload one for ${finding.description}${ref}`;
      case 'deadline_approaching':
        return `Deadline approaching — ${finding.description}${ref}`;
      case 'pending_approval':
        return `Approval needed — ${finding.description}${ref}`;
      case 'policy_hold':
        return `Policy hold — review ${finding.description}${ref}`;
      case 'unmatched_bank_line':
        return `Unmatched bank line — reconcile ${finding.description}${ref}`;
      case 'aging_invoice':
        return `Aging invoice — chase payment for ${finding.description}${ref}`;
      case 'personal_repayment':
        return `Personal repayment outstanding — ${finding.description}${ref}`;
      case 'anomaly':
        return `Anomaly flagged — ${finding.description}${ref}`;
      default:
        // Defensive: a legacy / directly-inserted row whose kind is outside
        // the current enum still gets a generic nag rather than crashing.
        return `${String(finding.finding_type)}: ${finding.description}${ref}`;
    }
  }
}
