import type { Selectable } from 'kysely';
import type { AllowanceTable } from '../database/types';
import type {
  ClaimantRelation,
  HealthEligibilityFacts,
} from '../plugins/health-allowance.types';
import { UnresolvedHealthAllowanceError } from '../plugins/health-allowance.errors';

const CLAIMANT_RELATIONS: readonly ClaimantRelation[] = [
  'employee',
  'board_member',
  'other',
];

/**
 * Read the eligibility facts off a stored allowance row (issue #212).
 *
 * Returns `null` when the row records NONE of them — a claim entered before
 * these columns existed. That is deliberately distinct from a row whose facts
 * are present and simply do not qualify: a legacy row is a data-quality gap
 * booked conservatively as fully taxable, and the books say which of the two it
 * was. What must never happen is either of them being read as "exempt".
 */
export function healthFactsFromRow(
  row: Selectable<AllowanceTable>,
): HealthEligibilityFacts | null {
  const relation = row.claimant_relation;
  const nothingRecorded =
    row.health_category === null &&
    relation === null &&
    row.supporting_document_id === null &&
    row.supporting_document_ref === null &&
    row.offered_to_all_employees === null;

  if (nothingRecorded) return null;

  return {
    category: row.health_category ?? '',
    // A relation outside the recorded set is read as 'other' — not as one of
    // the qualifying relationships. An unparseable value never qualifies.
    claimantRelation: CLAIMANT_RELATIONS.includes(relation as ClaimantRelation)
      ? (relation as ClaimantRelation)
      : 'other',
    supportingDocumentId: row.supporting_document_id,
    supportingDocumentRef: row.supporting_document_ref,
    providerRegistration: row.provider_registration,
    offeredToAllEmployees: row.offered_to_all_employees === 1,
  };
}

/** What a caller may send when creating a health claim. */
export interface HealthFactsInput {
  category?: string;
  claimantRelation?: string;
  supportingDocumentId?: number;
  supportingDocumentRef?: string;
  providerRegistration?: string;
  offeredToAllEmployees?: boolean;
}

/**
 * Require the facts a NEW health claim must carry, and refuse it otherwise.
 *
 * A new claim is refused rather than booked conservatively, because refusing is
 * the only answer that stays true: the caller is present, the facts are knowable
 * to them, and a claim silently booked as fully taxable would cost the employer
 * real money for a benefit that may well qualify. The 422 names each missing
 * fact and the call that supplies it, so an agent or operator can fix and
 * resubmit in one step.
 *
 * Legacy rows already in the database are NOT reached by this — they are booked
 * conservatively at approval time, explicitly, with `exemption_basis =
 * 'facts_missing'`. There is nobody left to ask about a row entered last year.
 */
export function requireHealthFacts(
  input: HealthFactsInput | undefined,
): HealthEligibilityFacts {
  const missing: string[] = [];
  const facts = input ?? {};

  if (!hasText(facts.category)) missing.push('health_category');
  if (
    !CLAIMANT_RELATIONS.includes(facts.claimantRelation as ClaimantRelation)
  ) {
    missing.push("claimant_relation ('employee' | 'board_member' | 'other')");
  }
  if (
    facts.supportingDocumentId === undefined &&
    !hasText(facts.supportingDocumentRef)
  ) {
    missing.push('supporting_document_id or supporting_document_ref');
  }
  if (typeof facts.offeredToAllEmployees !== 'boolean') {
    missing.push('offered_to_all_employees');
  }

  if (missing.length > 0) {
    throw new UnresolvedHealthAllowanceError({
      code: 'health_eligibility_facts_missing',
      message:
        `A health reimbursement is tax-exempt only up to a statutory limit and ` +
        `only when it meets the exemption's conditions. This claim does not ` +
        `record ${missing.join(', ')}, so whether any of it is exempt cannot be ` +
        `decided and nothing was created.`,
      missingFacts: missing,
      howToResolve:
        'POST /api/allowances with {"type":"health", "health_category":"sports_facility_fee", ' +
        '"claimant_relation":"employee", "supporting_document_ref":"INV-2026-114", ' +
        '"offered_to_all_employees":true} — plus "provider_registration" for a ' +
        'service whose eligibility depends on a registered provider.',
    });
  }

  return {
    category: facts.category as string,
    claimantRelation: facts.claimantRelation as ClaimantRelation,
    supportingDocumentId: facts.supportingDocumentId ?? null,
    supportingDocumentRef: hasText(facts.supportingDocumentRef)
      ? (facts.supportingDocumentRef as string)
      : null,
    providerRegistration: hasText(facts.providerRegistration)
      ? (facts.providerRegistration as string)
      : null,
    offeredToAllEmployees: facts.offeredToAllEmployees as boolean,
  };
}

function hasText(value: string | undefined | null): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}
