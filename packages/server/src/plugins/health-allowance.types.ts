// packages/server/src/plugins/health-allowance.types.ts

/**
 * Health / sports reimbursement: the statutory exemption, its accumulation
 * window, and the fringe-benefit tax the excess carries (issue #212).
 *
 * The kernel owns NONE of these numbers. A health reimbursement is exempt only
 * up to a cap that a jurisdiction sets, over a window that jurisdiction defines,
 * for a list of expenditure that jurisdiction allows — and every one of those
 * three has changed inside living memory (EE: a EUR 100 per QUARTER exemption
 * over a narrow list until 2024-12-31, a EUR 400 per YEAR exemption over an
 * expanded one from 2025-01-01). So the plugin is asked per DATE, and the
 * answer for a 2024 claim is not the answer for a 2026 one.
 */

/** Whether the cap accumulates per calendar year or per calendar quarter. */
export type HealthLimitWindowKind = 'year' | 'quarter';

/**
 * What the law in force on a given date allows. `null` from a plugin means the
 * jurisdiction has NO statutory health exemption — not "no limit".
 */
export interface HealthAllowanceRules {
  /** Which calendar window the cap accumulates over. */
  windowKind: HealthLimitWindowKind;
  /**
   * The cap per claimant per window, in base-currency minor units, INCLUDING
   * VAT (the exemption is measured on what the employer actually spent; a
   * health benefit carries no input-VAT deduction).
   */
  capPerClaimant: number;
  /**
   * The expenditure categories that qualify on this date. A category outside
   * the list is a perfectly legitimate benefit — it is simply taxable in full.
   */
  eligibleCategories: readonly string[];
  /**
   * The subset of {@link eligibleCategories} that qualifies ONLY when the
   * service was bought from a provider holding the required licence or
   * registration. A health service is not eligible because it is health-related
   * — it is eligible because a qualified provider on the statutory register
   * supplied it. For these, a claim must name that provider's registration, so
   * a general check-up invoice from an unlisted provider cannot pass as one.
   */
  categoriesRequiringProviderRegistration: readonly string[];
  /** The provision this came from, carried into the persisted exemption basis. */
  legalBasis: string;
}

/**
 * The relationship the claimant must stand in for the exemption to exist at
 * all. `other` is a recorded fact meaning "neither" — it is not "unknown", and
 * an unrecorded relation is never read as one of these.
 */
export type ClaimantRelation = 'employee' | 'board_member' | 'other';

/** The facts a health claim must carry before any of it can be called exempt. */
export interface HealthEligibilityFacts {
  /** Which category of health/sports expenditure this is. */
  category: string;
  /** The claimant's relationship to the employer. */
  claimantRelation: ClaimantRelation;
  /**
   * The supporting document. Either an intake Document already in the books, or
   * an external reference (invoice number / archive locator) when the paper
   * lives elsewhere. A boolean "yes we have documents" is not evidence: an
   * auditor asks WHICH document, so the claim carries the pointer itself.
   */
  supportingDocumentId: number | null;
  supportingDocumentRef: string | null;
  /**
   * The registration / licence number of the service provider, for the
   * categories whose eligibility depends on one.
   */
  providerRegistration: string | null;
  /** The benefit is available to every eligible employee, not to one person. */
  offeredToAllEmployees: boolean;
}

/**
 * Why the exempt part of a health claim was the size it was. Persisted on the
 * allowance so a posted claim can be explained from the books rather than from
 * whatever the rules happen to say today.
 */
export type HealthExemptionBasis =
  /** Fully or partly exempt under the jurisdiction's health/sports exemption. */
  | 'statutory_health_exemption'
  /** The window's cap was already consumed by earlier posted claims. */
  | 'limit_exhausted'
  /** The claim records facts, and those facts do not qualify. */
  | 'ineligible'
  /** The claim records no eligibility facts at all (legacy row). */
  | 'facts_missing'
  /** The jurisdiction has no health exemption on this date. */
  | 'no_statutory_exemption';

/**
 * The employer's own tax on a fringe benefit — owed IN ADDITION to what the
 * claimant is paid, never withheld from it.
 */
export interface FringeBenefitTax {
  /** Income tax on the benefit (EE from 2025: 22/78 of its value). */
  incomeTax: number;
  /** Social tax (EE: 33% of benefit + income tax). */
  socialTax: number;
  /** Expense account for the taxable benefit itself. */
  benefitExpenseAccount: string;
  /** Expense account for the two taxes. */
  taxExpenseAccount: string;
  /** Liability account for the income tax. */
  incomeTaxAccount: string;
  /** Liability account for the social tax. */
  socialTaxAccount: string;
  /** The rates this was computed at, for the persisted record. */
  basis: string;
}
