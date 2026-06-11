import { RuleResult } from './types';

/**
 * Returns true if the rule result represents an unresolved semantic failure.
 * Only semantic rules are overrideable per ADR-0005 — a passed semantic result
 * with an override is NOT a failure.
 */
export function isUnresolvedSemanticFailure(result: RuleResult): boolean {
  return result.overrideable && !result.passed;
}

/**
 * Returns true if the rule result represents a failure that MUST be rejected.
 * Structural and hard process rules are inviolable.
 */
export function mustReject(result: RuleResult): boolean {
  return !result.passed && !result.overrideable;
}
