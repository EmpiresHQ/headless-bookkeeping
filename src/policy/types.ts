/**
 * The two possible actions a Policy decision can produce.
 * There is NO 'reject' — structural/hard rule failures are rejected by
 * Rules before Policy is ever consulted (AC-5).
 */
export type PolicyAction = 'auto-post' | 'hold-for-approval';

/**
 * The outcome of PolicyService.decide().
 */
export interface PolicyDecision {
  action: PolicyAction;
  reason: string;
}

/**
 * Policy configuration parameters.
 * In v1 these are hardcoded defaults; in later waves they may be read from
 * the policy_config table.
 */
export interface PolicyConfig {
  /** Amount ceiling in cents. Above this, hold for approval. */
  auto_post_amount_ceiling: number;
  /** Minimum AI confidence for auto-post (stub — always 1.0 in v1). */
  auto_post_min_confidence: number;
  /** If true, vouchers involving an unknown supplier require approval. */
  unknown_supplier_requires_approval: boolean;
  /** Operations that always bypass amount/confidence gates (stub list). */
  always_approve_operations: string[];
}

/**
 * Contextual information fed to Policy.decide() alongside the voucher and
 * rule results. These are Policy inputs only — never fed to Rules.
 */
export interface PolicyContext {
  /** AI confidence score (0–1). Undefined → skip confidence check. */
  confidence?: number;
  /** Whether the supplier is known (matched to an Entity). */
  supplierKnown?: boolean;
}

/**
 * A persisted override record — an explicit, logged, human-authored exception
 * to a semantic rule, stored atomically with the post (AC-6).
 */
export interface OverrideRecord {
  id: number;
  business_object_type: string;
  business_object_id: number;
  rule_type: string;
  rule_name: string;
  reason: string;
  created_by: string;
  created_at: number;
}
