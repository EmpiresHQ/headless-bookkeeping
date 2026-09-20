import type {
  HealthAllowanceRules,
  HealthEligibilityFacts,
  HealthExemptionBasis,
  HealthLimitWindowKind,
} from '../plugins/health-allowance.types';
import { UnresolvedHealthAllowanceError } from '../plugins/health-allowance.errors';
import type { ExpressionBuilder } from 'kysely';
import type { Database } from '../database/types';

/** The expression builder {@link bookedClaim} is written against. */
export type HealthClaimEb = ExpressionBuilder<Database, 'allowance'>;

/**
 * The accumulation window a date falls in, as the key the allocation is
 * recorded against: '2026' for an annual cap, '2024-Q3' for a quarterly one.
 *
 * The KIND is part of the key, not just the boundaries, because the kind itself
 * changed (EE moved from a quarterly to an annual cap on 2025-01-01). Recording
 * '2024-Q3' rather than '2024' keeps a posted claim readable as what it was
 * measured against, even after the rules move under it.
 */
export function limitWindowKey(
  date: string,
  kind: HealthLimitWindowKind,
): string {
  const year = date.slice(0, 4);
  if (kind === 'year') return year;
  const month = Number(date.slice(5, 7));
  return `${year}-Q${Math.floor((month - 1) / 3) + 1}`;
}

/** Inclusive date bounds of the window a date falls in. */
export function limitWindowBounds(
  date: string,
  kind: HealthLimitWindowKind,
): { start: string; end: string } {
  const year = Number(date.slice(0, 4));
  if (kind === 'year') {
    return { start: `${year}-01-01`, end: `${year}-12-31` };
  }
  const quarter = Math.floor((Number(date.slice(5, 7)) - 1) / 3);
  const startMonth = quarter * 3 + 1;
  const endMonth = startMonth + 2;
  const lastDay = new Date(Date.UTC(year, endMonth, 0)).getUTCDate();
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    start: `${year}-${pad(startMonth)}-01`,
    end: `${year}-${pad(endMonth)}-${pad(lastDay)}`,
  };
}

/** The eligibility verdict: either the exemption applies, or exactly why not. */
export type EligibilityVerdict =
  | { eligible: true }
  | {
      eligible: false;
      basis: Extract<HealthExemptionBasis, 'ineligible' | 'facts_missing'>;
      reason: string;
    };

/**
 * Decide whether a health claim qualifies for the exemption AT ALL, before any
 * arithmetic about how much of the cap is left.
 *
 * Two different negatives, kept apart on purpose:
 *
 *  - `facts_missing` — the claim records nothing about eligibility. That is a
 *    legacy row from before these facts existed. It is booked as fully taxable
 *    and says so, rather than inheriting a default that nobody ever asserted.
 *  - `ineligible` — the claim DOES record facts and they do not qualify: a
 *    category outside the statutory list, a person in no employment or board
 *    relationship, a perk offered to one individual, a service whose
 *    eligibility depends on a registered provider with no registration named,
 *    or an expense with no document behind it.
 *
 * Both end in the same place — the whole amount is a taxable fringe benefit —
 * but only one of them is a data-quality problem, and an operator reading the
 * books needs to know which.
 */
export function assessHealthEligibility(
  facts: HealthEligibilityFacts | null,
  rules: HealthAllowanceRules,
): EligibilityVerdict {
  if (facts === null) {
    return {
      eligible: false,
      basis: 'facts_missing',
      reason:
        'The claim records no health-eligibility facts, so nothing about it ' +
        'can be shown to qualify; it is treated as a fully taxable benefit.',
    };
  }

  if (
    facts.claimantRelation !== 'employee' &&
    facts.claimantRelation !== 'board_member'
  ) {
    return {
      eligible: false,
      basis: 'ineligible',
      reason:
        `The exemption covers an employee or board member; this claimant is ` +
        `recorded as '${facts.claimantRelation}'.`,
    };
  }

  if (!rules.eligibleCategories.includes(facts.category)) {
    return {
      eligible: false,
      basis: 'ineligible',
      reason:
        `'${facts.category}' is not among the expenditure the exemption covers ` +
        `on this date (${rules.legalBasis}).`,
    };
  }

  if (
    rules.categoriesRequiringProviderRegistration.includes(facts.category) &&
    !hasText(facts.providerRegistration)
  ) {
    return {
      eligible: false,
      basis: 'ineligible',
      reason:
        `'${facts.category}' qualifies only when a registered provider supplied ` +
        `the service, and the claim names no provider registration. Being ` +
        `health-related is not by itself the condition.`,
    };
  }

  if (
    facts.supportingDocumentId === null &&
    !hasText(facts.supportingDocumentRef)
  ) {
    return {
      eligible: false,
      basis: 'ineligible',
      reason:
        'The claim points at no supporting document, so the expenditure cannot ' +
        'be evidenced on a person-based basis.',
    };
  }

  if (!facts.offeredToAllEmployees) {
    return {
      eligible: false,
      basis: 'ineligible',
      reason:
        'The benefit is not recorded as available to every eligible employee, ' +
        'so it is a taxable perk rather than an exempt health benefit.',
    };
  }

  return { eligible: true };
}

function hasText(value: string | null): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * The claim's authoritative date decides everything — which rules apply, which
 * window the cap accumulates in, and which tax rates the excess carries. A
 * caller-supplied year that disagrees with it is a contradiction, not a
 * preference to honour, so it is refused rather than silently ignored: the two
 * readings allocate against different windows, and the wrong one overspends a
 * cap while leaving another untouched.
 */
export function assertYearMatchesPeriod(
  periodStart: string,
  year: number,
): void {
  const derived = Number(periodStart.slice(0, 4));
  if (derived !== year) {
    throw new UnresolvedHealthAllowanceError({
      code: 'health_period_year_mismatch',
      message:
        `The claim's period starts ${periodStart} but the request asks for year ` +
        `${year}. The two allocate against different annual limits, so nothing ` +
        `was computed.`,
      missingFacts: [`allowance.period_start=${periodStart} vs year=${year}`],
      howToResolve:
        'Send the claim with a period_start inside the year it belongs to, or ' +
        'drop the year and let it be derived from period_start.',
    });
  }
}

/**
 * A claim may not straddle two accumulation windows: half of it would be
 * measured against one cap and half against another, and there is no recorded
 * fact saying how the amount divides between them.
 */
export function assertSingleWindow(
  periodStart: string,
  periodEnd: string | null | undefined,
  kind: HealthLimitWindowKind,
): void {
  if (!periodEnd) return;
  const startKey = limitWindowKey(periodStart, kind);
  const endKey = limitWindowKey(periodEnd, kind);
  if (startKey !== endKey) {
    throw new UnresolvedHealthAllowanceError({
      code: 'health_claim_spans_two_limit_windows',
      message:
        `The claim runs ${periodStart}…${periodEnd}, which crosses from limit ` +
        `window ${startKey} into ${endKey}. Nothing records how the amount ` +
        `divides between the two caps, so nothing was computed.`,
      missingFacts: [
        `allowance.period_start=${periodStart}, allowance.period_end=${periodEnd}`,
      ],
      howToResolve: `Enter one claim per ${kind} window, each with the amount incurred in it.`,
    });
  }
}

/**
 * A health claim counts against the cap — and is reported — once its money is
 * in the books.
 *
 * Keyed on the VOUCHER as well as the status, deliberately. The status says
 * what the workflow thinks; the voucher says what the ledger holds. If a claim
 * were ever marked cancelled or rejected while its posted voucher remained
 * live, a status-only rule would hand its share of the cap back while the
 * expense was still booked, and the next claim would spend a limit that is
 * already spent.
 *
 * A reversal does NOT release it here, even though that is the direction a
 * release would come from. The ledger supports partial reversals and reversal
 * chains, so the mere existence of a voucher pointing back at this one does not
 * establish that the whole benefit was economically undone — and freeing a
 * whole year's exemption on an ambiguous chain is the expensive way to be
 * wrong. Usage therefore stays conservative, and a claim whose voucher has been
 * reversed in any way is surfaced by the health benefit report as needing
 * review rather than silently dropped from the totals or from the cap. There is
 * no correction path for a posted allowance in v1 to produce such a chain
 * through this API in the first place.
 *
 * Pass it to `.where()` on a query over `allowance`.
 */
export function bookedClaim(eb: HealthClaimEb) {
  return eb.or([eb('status', '=', 'posted'), eb('voucher_id', 'is not', null)]);
}
