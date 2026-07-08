import { Injectable, Logger } from '@nestjs/common';
import { AuditFindingsService } from '../audit-findings/audit-findings.service';
import { AuditFinding } from '../audit-findings/types';
import { ConversationsService } from '../conversations/conversations.service';
import type { Conversation } from '../conversations/types';
import { InteractionConfigService } from '../interaction/config/interaction-config.service';
import { TelegramApprovalSupportService } from '../interaction/telegram-approval-support.service';
import { TransportRegistryService } from '../interaction/transport/transport-registry.service';

/**
 * SecretaryAgent — stub with notify.
 *
 * Role: the only proactive, user-facing agent. Reads open AuditFindings
 * and nags users via Telegram/Slack/email at a cadence driven by each
 * finding's severity (low → ~daily, high → ~hourly).
 *
 * In this MVP: notify() still logs every open finding, and additionally sends
 * Telegram nags for Telegram-actionable pending approvals when the approver has
 * an existing private 1:1 bot conversation. Working-hours gating and anti-spam
 * discipline are deferred.
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

  constructor(
    private readonly auditFindingsService: AuditFindingsService,
    private readonly transportRegistry: TransportRegistryService,
    private readonly interactionConfig: InteractionConfigService,
    private readonly conversationsService: ConversationsService,
    private readonly telegramApprovalSupport: TelegramApprovalSupportService,
  ) {}

  /** Notify — reads open findings, logs them, and delivers the MVP Telegram nag. */
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
      await this.notifyTelegramApproversForPendingApproval(finding, nag);
    }
  }

  private async notifyTelegramApproversForPendingApproval(
    finding: AuditFinding,
    nag: string,
  ): Promise<void> {
    if (
      finding.finding_type !== 'pending_approval' ||
      finding.referenced_object_type !== 'approval' ||
      finding.referenced_object_id === null
    ) {
      return;
    }

    const approvalId = finding.referenced_object_id;
    const actionable =
      await this.telegramApprovalSupport.isTelegramApprovable(approvalId);
    if (!actionable) {
      return;
    }

    const approvers = await this.telegramApprovers();
    for (const approverId of approvers) {
      const convKey = `tg:${approverId}`;
      const existingConversation = await this.findTelegramConversation(convKey);
      if (!existingConversation) {
        continue;
      }

      // MVP precondition: delivery is only claimed for an existing private 1:1
      // Telegram chat whose conversation key matches tg:<approver-id>. That
      // existing thread proves the approver already started the bot.
      const conversation = await this.conversationsService.resolve({
        channel: 'telegram',
        thread_key: convKey,
      });

      await this.transportRegistry.send({
        channel: 'telegram',
        convKey,
        text: nag,
        actionPoints: [
          { id: `approve:${approvalId}`, label: 'Approve' },
          { id: `reject:${approvalId}`, label: 'Reject' },
        ],
      });
      await this.conversationsService.appendMessage({
        conversation_id: conversation.id,
        direction: 'outbound',
        sender: 'SecretaryAgent',
        body: nag,
        threading_keys: null,
      });
    }
  }

  private async telegramApprovers(): Promise<Set<string>> {
    const approvers = await this.interactionConfig.getApprovers();
    const allowlist = await this.interactionConfig.getTelegramAllowlist();
    return new Set([...approvers].filter((id) => allowlist.has(id)));
  }

  private async findTelegramConversation(
    convKey: string,
  ): Promise<Conversation | undefined> {
    const conversations = await this.conversationsService.list();
    return conversations.find(
      (conversation) =>
        conversation.channel === 'telegram' &&
        conversation.thread_key === convKey,
    );
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
