import { ValidatableLine } from '../ledger/validation/types';
import { SupplierFacts, OrgContext } from '../plugins/country-plugin.interface';

/**
 * A resolved voucher line ready for rule validation.
 * Extends ValidatableLine with the VAT code and category assigned
 * by the single account resolver (AC-4).
 */
export interface ResolvedLine extends ValidatableLine {
  /** The VAT code assigned by the country plugin resolver. */
  vat_code: string;
  /** The user-facing category (e.g. "software", "transport"). */
  category: string;
}

/**
 * The three Rules tiers (CONTEXT.md → "Rules"): structural invariants and hard
 * process rules are inviolable; semantic rules are overridable.
 */
export type RuleTier = 'structural' | 'hard_process' | 'semantic';

/**
 * Result of running a single rule tier.
 */
export interface RuleResult {
  /** Whether the tier passed (or was overridden). */
  passed: boolean;
  /** The rule tier that was evaluated. */
  ruleType: RuleTier;
  /** Human-readable message (success, error list, or override reason). */
  message: string;
  /** Whether a failure on this tier may be overridden. */
  overrideable: boolean;
}

/**
 * The single input bag for the unified tier interface
 * ({@link RulesService.validate} / {@link RulesService.validateAll}). Each tier
 * reads only the fields it needs; a caller fills the bag once and any tier can
 * run from it, so callers no longer juggle two different validation shapes.
 */
export interface TierValidationInput {
  /** Resolved lines — used by the structural and semantic tiers. */
  resolvedLines?: ResolvedLine[];
  /** Valid account IDs from the seeded chart — used by the structural tier. */
  validAccountIds?: Set<number>;
  /** Tax-point date — used by the hard-process (period-lock) tier. */
  taxPointDate?: string;
  /** Semantic context (supplier facts, org context, country, category). */
  context?: SemanticValidationContext;
  /** Optional logged override (only effective for the semantic tier). */
  override?: Override;
  /**
   * Pre-filtered subset of {@link resolvedLines} that carry a real VAT code —
   * the only lines the semantic tier should evaluate. {@link RulesService.validateAll}
   * runs the semantic tier on this subset (skipping it when empty); a NULL_STANDARD
   * placeholder is not semantically meaningful.
   */
  semanticLines?: ResolvedLine[];
}

/**
 * All three tier results from a single {@link RulesService.validateAll} call,
 * in declaration order. Spread into the array Policy consumes.
 */
export interface TierResults {
  structural: RuleResult;
  hardProcess: RuleResult;
  semantic: RuleResult;
}

/**
 * An explicit, logged, human-authored exception to a semantic rule.
 * Structural invariants can NEVER be overridden (ADR-0005).
 */
export interface Override {
  /** The rule type being overridden (must match the tier). */
  ruleType: string;
  /** The human-authored reason for the override. */
  reason: string;
}

/**
 * Context required for semantic rule validation.
 * Passed to the CountryPlugin for VAT code and category mapping checks.
 */
export interface SemanticValidationContext {
  /** ISO country code used to resolve the active CountryPlugin. */
  countryCode: string;
  /** Intrinsic facts about the supplier (for category mapping). */
  supplierFacts: SupplierFacts;
  /** Organization context (VAT registration, base currency, etc.). */
  orgContext: OrgContext;
  /** The business object's real Category (e.g. "software", "revenue"). */
  category: string;
  /**
   * Whether VAT was charged on the counterparty's source document (a hint the
   * country plugin reads when resolving cross-border treatment, ADR-0002).
   * Defaults to false when unknown (conservative: no foreign VAT reclaimed).
   */
  vatCharged?: boolean;
}
