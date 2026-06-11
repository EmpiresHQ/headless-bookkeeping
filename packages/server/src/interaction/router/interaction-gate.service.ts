// src/interaction/router/interaction-gate.service.ts
import { Injectable } from '@nestjs/common';
import { AuditLogService } from '../../audit-log/audit-log.service';
import { canCommit, canConverse } from '../principal/interaction-gate';
import { Principal } from '../principal/types';

/**
 * Concentrates the gate→audit-action mapping for the two commit/converse gates.
 *
 * Each method:
 *  1. Evaluates the pure gate predicate (canCommit / canConverse).
 *  2. Records exactly the audit row the router used to write inline.
 *  3. Returns `true` when the caller is allowed to proceed.
 *
 * The `unknown_callback` audit belongs here too: it is logically part of the
 * commit gate — the principal was allowed but the token itself was stale.
 */
@Injectable()
export class InteractionGateService {
  constructor(private readonly audit: AuditLogService) {}

  /**
   * Gate for Action-point commits (button taps).
   *
   * Denied  → records `interaction.action_point.commit` / `denied`   → returns false.
   * Allowed + valid callback  → records `interaction.action_point.commit` / `accepted` → returns true.
   * Allowed + unknown callback → records `interaction.action_point.unknown_callback` / `rejected` → returns true
   *   (the principal is past the gate; the token was just stale — gated_in stays true).
   */
  async gateCommit(
    principal: Principal,
    conversationId: number,
    detail: { callbackData: string },
    callbackIsKnown: boolean,
  ): Promise<boolean> {
    if (!canCommit(principal)) {
      await this.audit.record({
        actor: principal.senderId,
        action: 'interaction.action_point.commit',
        outcome: 'denied',
        target_type: 'conversation',
        target_id: conversationId,
        detail,
      });
      return false;
    }

    if (!callbackIsKnown) {
      await this.audit.record({
        actor: principal.senderId,
        action: 'interaction.action_point.unknown_callback',
        outcome: 'rejected',
        target_type: 'conversation',
        target_id: conversationId,
        detail,
      });
    } else {
      await this.audit.record({
        actor: principal.senderId,
        action: 'interaction.action_point.commit',
        outcome: 'accepted',
        target_type: 'conversation',
        target_id: conversationId,
        detail,
      });
    }

    return true;
  }

  /**
   * Gate for text-message conversations.
   *
   * Denied → records `interaction.gate.converse_denied` / `denied` → returns false.
   * Allowed → no audit record (matches original behaviour) → returns true.
   */
  async gateConverse(
    principal: Principal,
    conversationId: number,
  ): Promise<boolean> {
    if (!canConverse(principal)) {
      await this.audit.record({
        actor: principal.senderId,
        action: 'interaction.gate.converse_denied',
        outcome: 'denied',
        target_type: 'conversation',
        target_id: conversationId,
      });
      return false;
    }
    return true;
  }
}
