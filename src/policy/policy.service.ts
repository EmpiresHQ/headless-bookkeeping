import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely } from 'kysely';
import { Database } from '../database/types';
import { DraftVoucher } from '../ledger/voucher/types';
import { RuleResult } from '../rules/types';
import { canOverride, mustReject } from '../rules/rules.guards';
import { PolicyDecision, PolicyConfig, OverrideRecord } from './types';

/**
 * Hardcoded v1 defaults. In later waves these may be read from the
 * policy_config table and overridden per-Organization.
 */
const DEFAULT_CONFIG: PolicyConfig = {
  auto_post_amount_ceiling: 100000, // 1000 EUR in cents
  auto_post_min_confidence: 0.8,
  unknown_supplier_requires_approval: true,
  always_approve_operations: ['correction', 'reversal', 'vat_lock'],
};

/**
 * PolicyService — the risk gate that decides whether a Rules-valid voucher
 * auto-posts or is held for human approval.
 *
 * Wave-3 behaviour:
 * - Defaults to auto-post for everything except explicit hold conditions.
 * - Structural/hard failures should never reach Policy (Rules rejects first),
 *   but we guard defensively.
 * - Semantic failures without an override → hold.
 * - Amount above ceiling → hold.
 * - AI confidence and supplier checks are stubbed (always pass in v1).
 */
@Injectable()
export class PolicyService {
  constructor(@InjectKysely() private readonly db: Kysely<Database>) {}

  /**
   * Decide whether a draft voucher should auto-post or be held for approval.
   *
   * @param voucher — the draft voucher being evaluated
   * @param ruleResults — results from RulesService.validate() for all tiers
   */
  decide(voucher: DraftVoucher, ruleResults: RuleResult[]): PolicyDecision {
    // 1. Defensive guard: structural/hard failures should never reach Policy,
    //    but if they do, hold for approval.
    const structuralOrHardFailure = ruleResults.find((r) => mustReject(r));
    if (structuralOrHardFailure) {
      return {
        action: 'hold-for-approval',
        reason: `Structural/hard rule failure: ${structuralOrHardFailure.message}`,
      };
    }

    // 2. Semantic failure without override.
    //    By the time Policy sees ruleResults, any override has already been
    //    applied in RulesService. A remaining semantic failure means no
    //    override was supplied.
    const semanticFailure = ruleResults.find((r) => canOverride(r));
    if (semanticFailure) {
      return {
        action: 'hold-for-approval',
        reason: `Semantic rule failure: ${semanticFailure.message}`,
      };
    }

    // 3. Amount ceiling check (sum of debit base_amounts = voucher size).
    const totalBaseAmount = voucher.lines
      .filter((l) => l.is_debit)
      .reduce((sum, l) => sum + l.base_amount, 0);
    if (totalBaseAmount > DEFAULT_CONFIG.auto_post_amount_ceiling) {
      return {
        action: 'hold-for-approval',
        reason: `Voucher amount ${totalBaseAmount} exceeds ceiling ${DEFAULT_CONFIG.auto_post_amount_ceiling}`,
      };
    }

    // 4. AI confidence stub — always 1.0 in v1, so always passes.
    //    In later waves this will be a real input from the AI pipeline.
    const confidence = 1.0;
    if (confidence < DEFAULT_CONFIG.auto_post_min_confidence) {
      return {
        action: 'hold-for-approval',
        reason: `AI confidence ${confidence} below threshold ${DEFAULT_CONFIG.auto_post_min_confidence}`,
      };
    }

    // 5. Default: auto-post.
    return {
      action: 'auto-post',
      reason: 'All rules passed and amount within ceiling',
    };
  }

  /**
   * Return the current policy configuration.
   * In v1 this returns hardcoded defaults.
   */
  getConfig(): PolicyConfig {
    return { ...DEFAULT_CONFIG };
  }

  /**
   * Log an override atomically with the posting transaction (AC-6).
   * This is called by the posting path, NOT via a free-standing endpoint.
   */
  async logOverride(
    record: Omit<OverrideRecord, 'id' | 'created_at'>,
  ): Promise<OverrideRecord> {
    const now = Math.floor(Date.now() / 1000);
    const result = await this.db
      .insertInto('override')
      .values({
        business_object_type: record.business_object_type,
        business_object_id: record.business_object_id,
        rule_type: record.rule_type,
        rule_name: record.rule_name,
        reason: record.reason,
        created_by: record.created_by,
        created_at: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return result;
  }

  /**
   * List all override records for audit (read-only).
   */
  async getOverrides(): Promise<OverrideRecord[]> {
    return this.db
      .selectFrom('override')
      .selectAll()
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .execute();
  }
}
