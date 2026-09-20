import type { OrgContext } from './country-plugin.interface';
import {
  FULL_ENTITLEMENT,
  InputVatEntitlement,
  NO_ENTITLEMENT,
} from './input-vat-entitlement.types';
import { UnresolvedVatTreatmentError } from './vat-treatment.errors';

/**
 * The part of input-VAT entitlement that is not jurisdiction-specific (issue
 * #211): read the organisation's OWN recorded VAT facts and turn them into a
 * deductible fraction. A plugin calls this after applying whatever additional
 * rule its jurisdiction has (EE: a limited registration deducts nothing).
 *
 * The one rule that is never negotiable here: an organisation that is not
 * VAT-registered has no deduction right, and a percentage recorded against it
 * cannot create one. Rather than quietly clamping such a contradiction to zero
 * — which would hide a settings error that someone will later "fix" by raising
 * the percentage — it is refused, with the two fields named.
 */
export function entitlementFromOrgContext(
  orgContext: OrgContext,
): InputVatEntitlement {
  const entitlement = orgContext.inputVatEntitlement ?? 'full';

  if (!orgContext.vatRegistered) {
    if (entitlement !== 'none') {
      throw new UnresolvedVatTreatmentError({
        code: 'input_vat_entitlement_contradicts_registration',
        message:
          `The organisation is not VAT-registered but records an input-VAT ` +
          `entitlement of '${entitlement}'. A person who is not registered has ` +
          `no right to deduct input VAT, so the two settings cannot both be ` +
          `true and nothing was posted.`,
        missingFacts: [
          `organization.vat_registered=false with organization.input_vat_entitlement=${entitlement}`,
        ],
        howToResolve:
          'PUT /api/organization with {"vat_registered":true} if the ' +
          'organisation IS registered, or {"input_vat_entitlement":"none"} if ' +
          'it is not.',
      });
    }
    return NO_ENTITLEMENT('not_registered');
  }

  switch (entitlement) {
    case 'full':
      return FULL_ENTITLEMENT;
    case 'none':
      return NO_ENTITLEMENT('none');
    case 'partial':
      return partialEntitlement(orgContext.inputVatDeductionPermille);
    default:
      throw new UnresolvedVatTreatmentError({
        code: 'input_vat_entitlement_unsupported',
        message:
          `The organisation records an input-VAT entitlement of ` +
          `'${String(entitlement)}', which is not one of 'full', 'partial' or ` +
          `'none'. Nothing was posted.`,
        missingFacts: [
          `organization.input_vat_entitlement=${String(entitlement)}`,
        ],
        howToResolve:
          'PUT /api/organization with {"input_vat_entitlement":"full"}, ' +
          '"partial" (plus "input_vat_deduction_permille"), or "none".',
      });
  }
}

/**
 * A partial proportion is deductible only if it is a whole number of per mille
 * in 0…1000. Anything else is refused rather than rounded into shape: the value
 * multiplies every purchase's tax, so a wrong one is wrong on every return.
 */
function partialEntitlement(
  permille: number | null | undefined,
): InputVatEntitlement {
  if (
    permille === null ||
    permille === undefined ||
    !Number.isSafeInteger(permille) ||
    permille < 0 ||
    permille > 1000
  ) {
    throw new UnresolvedVatTreatmentError({
      code: 'input_vat_deduction_proportion_missing',
      message:
        `The organisation deducts input VAT only in part, but the deductible ` +
        `proportion is ${permille === null || permille === undefined ? 'not recorded' : `recorded as ${String(permille)}`} ` +
        `rather than a whole number of per mille between 0 and 1000. The ` +
        `deductible amount cannot be computed, so nothing was posted.`,
      missingFacts: ['organization.input_vat_deduction_permille'],
      howToResolve:
        'PUT /api/organization with {"input_vat_entitlement":"partial",' +
        '"input_vat_deduction_permille":500} for a 50% proportion.',
    });
  }
  return { numerator: permille, denominator: 1000, basis: 'partial' };
}
