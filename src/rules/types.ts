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
 * Result of running a single rule tier.
 */
export interface RuleResult {
  /** Whether the tier passed (or was overridden). */
  passed: boolean;
  /** The rule tier that was evaluated. */
  ruleType: string;
  /** Human-readable message (success, error list, or override reason). */
  message: string;
  /** Whether a failure on this tier may be overridden. */
  overrideable: boolean;
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
}
