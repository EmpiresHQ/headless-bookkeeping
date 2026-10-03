import type { CrossBorderTreatment, VATCode } from './country-plugin.interface';

/**
 * Why input VAT was deductible, or was not (issue #211). The basis travels onto
 * the posted voucher, so a return can be explained from the ledger rather than
 * from whatever the organisation's settings happen to say today.
 */
export type InputVatEntitlementBasis =
  /** Not a VAT-registered person: no deduction right exists at all. */
  | 'not_registered'
  /** Registered with LIMITED liability: self-assesses output, deducts nothing. */
  | 'limited_registration'
  /** Ordinary registration, inputs used wholly for deductible supply. */
  | 'full'
  /** Ordinary registration, inputs used only partly for deductible supply. */
  | 'partial'
  /** Ordinary registration, but this input carries no deduction right. */
  | 'none'
  /** The receipt is not addressed to the organisation, so nothing is reclaimable. */
  | 'receipt_not_company_addressed';

/**
 * The deductible proportion of input VAT, as an EXACT integer fraction.
 *
 * A fraction rather than a rate: the deductible amount is `vat * numerator /
 * denominator` rounded once, and the non-deductible remainder is the
 * subtraction of that result from the tax — so the two parts always sum back to
 * the tax exactly, in every currency, at every awkward cent amount. A float
 * percentage cannot promise that.
 */
export interface InputVatEntitlement {
  /** 0 ≤ numerator ≤ denominator, integer. */
  numerator: number;
  /** A positive integer. */
  denominator: number;
  basis: InputVatEntitlementBasis;
}

/**
 * What the plugin is being asked about: the treatment this purchase resolved to
 * and the VAT code the deductible leg would carry. Both are passed so a
 * jurisdiction can make the entitlement depend on them (e.g. a category with a
 * statutory deduction restriction) without the kernel knowing that it might.
 */
export interface InputVatEntitlementContext {
  treatment: CrossBorderTreatment;
  vatCode: VATCode;
}

export const FULL_ENTITLEMENT: InputVatEntitlement = {
  numerator: 1,
  denominator: 1,
  basis: 'full',
};

export const NO_ENTITLEMENT = (
  basis: InputVatEntitlementBasis,
): InputVatEntitlement => ({ numerator: 0, denominator: 1, basis });

/**
 * Apply an entitlement to a tax amount, returning the integer partition
 * `deductible + nonDeductible === vatAmount` — exactly, by construction: only
 * the deductible part is rounded, and the remainder is what is left of the tax.
 * Two independently rounded halves would drift a cent apart and unbalance the
 * voucher; this cannot.
 */
export function splitInputVat(
  vatAmount: number,
  entitlement: InputVatEntitlement,
): { deductible: number; nonDeductible: number } {
  const { numerator, denominator } = entitlement;
  const product = vatAmount * numerator;
  if (!Number.isSafeInteger(product)) {
    throw new RangeError(
      `Input-VAT deduction of ${vatAmount} at ${numerator}/${denominator} ` +
        `exceeds exact integer arithmetic; refusing to compute it approximately.`,
    );
  }
  const deductible = Math.round(product / denominator);
  return { deductible, nonDeductible: vatAmount - deductible };
}

/**
 * Validate an entitlement a plugin produced. The kernel checks it because the
 * fraction drives money: a denominator of 0, a numerator above the denominator
 * or a non-integer pair would silently produce a wrong — or infinite —
 * deduction.
 */
export function assertValidEntitlement(e: InputVatEntitlement): void {
  const ok =
    Number.isSafeInteger(e.numerator) &&
    Number.isSafeInteger(e.denominator) &&
    e.denominator > 0 &&
    e.numerator >= 0 &&
    e.numerator <= e.denominator;
  if (!ok) {
    throw new RangeError(
      `The country plugin returned an unusable input-VAT deduction fraction ` +
        `${e.numerator}/${e.denominator} (basis '${e.basis}'). It must be a ` +
        `whole fraction between 0 and 1.`,
    );
  }
}
