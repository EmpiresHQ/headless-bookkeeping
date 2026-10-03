import type { OrgContext, VATCode } from './country-plugin.interface';

/**
 * Whether a payment received in advance creates a TAX POINT of its own, and at
 * what rate (issue #213).
 *
 * This is a jurisdiction question, so the country plugin owns it (ADR-0002).
 * "The code describes an output supply" is not the same question: a rule may
 * tax a supply while expressly denying that a payment for it advances the tax
 * point, and a registration may make someone liable for acquisitions without
 * making their own supplies taxable. Both are real, and both would otherwise
 * be decided by the kernel guessing.
 *
 * `supported: false` is a HOLD, never a fallback: the caller refuses with the
 * message and the resolution route, and nothing is posted.
 */
export type AdvanceTaxPointDecision =
  | {
      supported: true;
      vatCode: VATCode;
      /** The rate in force on the receipt date, in per mille (240 = 24%). */
      ratePermille: number;
    }
  | {
      supported: false;
      /** Stable machine code, e.g. 'limited_registration'. */
      code: string;
      message: string;
      howToResolve: string;
    };

/** What the plugin is asked about: this code, this money, on this day. */
export interface AdvanceTaxPointContext {
  vatCode: VATCode;
  /** The day the payment was received — the candidate tax point. */
  receiptDate: string;
  orgContext: OrgContext;
}
