import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely } from 'kysely';
import { Database } from '../database/types';
import { DraftVoucher } from '../ledger/voucher/types';
import { RuleResult } from '../rules/types';
import { isUnresolvedSemanticFailure, mustReject } from '../rules/rules.guards';
import {
  PolicyDecision,
  PolicyConfig,
  OverrideRecord,
  PolicyContext,
} from './types';

/**
 * In-code fallback config. The authoritative source is the `policy_config`
 * table (seeded with these same values by migration 009); this constant is
 * used only to seed and as the per-key fallback when a row is absent
 * (ADR-0005: Policy is the configurable risk gate, table-backed).
 *
 * `auto_post_amount_ceiling` is denominated in BASE-CURRENCY minor units
 * (it gates `totalBaseAmount`, which is already in base currency). It is NOT
 * a EUR figure — each deployment sets its own ceiling via the table, in its
 * own base currency's minor units. The default 100000 is 1000.00 in whatever
 * the deployment's base currency is (EUR for the default Ireland deployment).
 */
const DEFAULT_CONFIG: PolicyConfig = {
  auto_post_amount_ceiling: 100000, // 1000.00 base-currency major units, in minor units (cents)
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
  async decide(
    voucher: DraftVoucher,
    ruleResults: RuleResult[],
    context?: PolicyContext,
  ): Promise<PolicyDecision> {
    // Table-backed config (ADR-0005). Resolved once per decision.
    const config = await this.getConfig();

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
    const semanticFailure = ruleResults.find((r) =>
      isUnresolvedSemanticFailure(r),
    );
    if (semanticFailure) {
      return {
        action: 'hold-for-approval',
        reason: `Semantic rule failure: ${semanticFailure.message}`,
      };
    }

    // 3. Amount ceiling check (sum of debit base_amounts = voucher size).
    //    Both sides are in BASE-CURRENCY minor units — no currency conversion
    //    happens or is needed here (the ceiling is base-currency-native).
    const totalBaseAmount = voucher.lines
      .filter((l) => l.is_debit)
      .reduce((sum, l) => sum + l.base_amount, 0);
    if (totalBaseAmount > config.auto_post_amount_ceiling) {
      return {
        action: 'hold-for-approval',
        reason: `Voucher amount ${totalBaseAmount} exceeds ceiling ${config.auto_post_amount_ceiling}`,
      };
    }

    // 4. AI confidence gate — only when confidence is provided.
    if (context?.confidence !== undefined) {
      const threshold = config.auto_post_min_confidence;
      if (context.confidence < threshold) {
        return {
          action: 'hold-for-approval',
          reason: `AI confidence ${context.confidence} below threshold ${threshold}`,
        };
      }
    }

    // 5. Unknown-supplier gate.
    if (
      context?.supplierKnown === false &&
      config.unknown_supplier_requires_approval
    ) {
      return {
        action: 'hold-for-approval',
        reason: 'Unknown supplier requires approval',
      };
    }

    // 6. Default: auto-post.
    return {
      action: 'auto-post',
      reason: 'All rules passed and amount within ceiling',
    };
  }

  /**
   * Return the current policy configuration, read from the `policy_config`
   * table (the seam ADR-0005 intended). Each key falls back to DEFAULT_CONFIG
   * when its row is absent, so a freshly-seeded deployment and a partially-
   * configured one both resolve to a complete, valid config.
   *
   * Values are stored as text; each key is parsed by its expected shape.
   */
  async getConfig(): Promise<PolicyConfig> {
    const rows = await this.db
      .selectFrom('policy_config')
      .select(['key', 'value'])
      .execute();

    const byKey = new Map(rows.map((r) => [r.key, r.value]));

    return {
      auto_post_amount_ceiling: this.parseInteger(
        byKey.get('auto_post_amount_ceiling'),
        DEFAULT_CONFIG.auto_post_amount_ceiling,
      ),
      auto_post_min_confidence: this.parseNumber(
        byKey.get('auto_post_min_confidence'),
        DEFAULT_CONFIG.auto_post_min_confidence,
      ),
      unknown_supplier_requires_approval: this.parseBoolean(
        byKey.get('unknown_supplier_requires_approval'),
        DEFAULT_CONFIG.unknown_supplier_requires_approval,
      ),
      always_approve_operations: this.parseStringArray(
        byKey.get('always_approve_operations'),
        DEFAULT_CONFIG.always_approve_operations,
      ),
    };
  }

  /**
   * Upsert the provided policy-config keys (A3). Only keys present in `patch`
   * are written; absent keys are left untouched. Values are serialised to the
   * text shape getConfig() parses back. Returns the fully-resolved config.
   */
  async updateConfig(patch: Partial<PolicyConfig>): Promise<PolicyConfig> {
    const now = Math.floor(Date.now() / 1000);
    const entries: Array<{ key: string; value: string }> = [];

    if (patch.auto_post_amount_ceiling !== undefined) {
      entries.push({
        key: 'auto_post_amount_ceiling',
        value: String(patch.auto_post_amount_ceiling),
      });
    }
    if (patch.auto_post_min_confidence !== undefined) {
      entries.push({
        key: 'auto_post_min_confidence',
        value: String(patch.auto_post_min_confidence),
      });
    }
    if (patch.unknown_supplier_requires_approval !== undefined) {
      entries.push({
        key: 'unknown_supplier_requires_approval',
        value: patch.unknown_supplier_requires_approval ? 'true' : 'false',
      });
    }
    if (patch.always_approve_operations !== undefined) {
      entries.push({
        key: 'always_approve_operations',
        value: JSON.stringify(patch.always_approve_operations),
      });
    }

    for (const e of entries) {
      await this.db
        .insertInto('policy_config')
        .values({ key: e.key, value: e.value, updated_at: now })
        .onConflict((oc) =>
          oc.column('key').doUpdateSet({ value: e.value, updated_at: now }),
        )
        .execute();
    }

    return this.getConfig();
  }

  private parseInteger(raw: string | undefined, fallback: number): number {
    if (raw === undefined) return fallback;
    const parsed = Number.parseInt(raw, 10);
    return Number.isInteger(parsed) ? parsed : fallback;
  }

  private parseNumber(raw: string | undefined, fallback: number): number {
    if (raw === undefined) return fallback;
    const parsed = Number.parseFloat(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  private parseBoolean(raw: string | undefined, fallback: boolean): boolean {
    if (raw === undefined) return fallback;
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    return fallback;
  }

  private parseStringArray(
    raw: string | undefined,
    fallback: string[],
  ): string[] {
    if (raw === undefined) return fallback;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return fallback;
    }
    if (
      Array.isArray(parsed) &&
      parsed.every((v): v is string => typeof v === 'string')
    ) {
      return parsed;
    }
    return fallback;
  }

  /**
   * Log an override atomically with the posting transaction (AC-6).
   * This is called by the posting path, NOT via a free-standing endpoint.
   *
   * When called from inside a transaction, prefer `logOverrideTx` so the
   * override row and the voucher commit or roll back together (ADR-0005 / ADR-0012).
   */
  async logOverride(
    record: Omit<OverrideRecord, 'id' | 'created_at'>,
  ): Promise<OverrideRecord> {
    return this.insertOverride(this.db, record);
  }

  /**
   * Transaction-aware variant of logOverride — uses the supplied Kysely
   * instance (which may be a transaction handle) for the INSERT.
   *
   * Called by PostingPipelineService.atomicPost inside the same transaction
   * as the voucher write and status update.
   */
  async logOverrideTx(
    trx: Kysely<Database>,
    record: Omit<OverrideRecord, 'id' | 'created_at'>,
  ): Promise<OverrideRecord> {
    return this.insertOverride(trx, record);
  }

  private async insertOverride(
    db: Kysely<Database>,
    record: Omit<OverrideRecord, 'id' | 'created_at'>,
  ): Promise<OverrideRecord> {
    const now = Math.floor(Date.now() / 1000);
    const result = await db
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
   * List all override records for audit (read-only), with optional pagination.
   *
   * @param limit - Max records to return (default 100)
   * @param offset - Number of records to skip (default 0)
   */
  async getOverrides(
    limit: number = 100,
    offset: number = 0,
  ): Promise<OverrideRecord[]> {
    return this.db
      .selectFrom('override')
      .selectAll()
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(limit)
      .offset(offset)
      .execute();
  }
}
