import { UnprocessableEntityException } from '@nestjs/common';

/**
 * A health reimbursement cannot be classified from what is recorded, so NOTHING
 * is posted (issue #212).
 *
 * Raised for two situations, both of which used to end in a silent full
 * exemption:
 *
 *  - the claim does not record the facts the exemption depends on, and an
 *    unrecorded fact is not a qualifying one;
 *  - the benefit's date falls outside the range whose statutory rates were
 *    actually verified, so no rate can be applied without inventing one.
 *
 * Carried as a 422 with the missing facts named and the call that supplies
 * them, so every entry point refuses identically and actionably — the same
 * shape as {@link UnresolvedVatTreatmentError} (issue #209/#211).
 */
export class UnresolvedHealthAllowanceError extends UnprocessableEntityException {
  /** Stable machine code, e.g. 'health_eligibility_facts_missing'. */
  readonly code: string;
  /** The facts that are missing or out of range. */
  readonly missingFacts: string[];
  /** The supported call that supplies them. */
  readonly howToResolve: string;

  constructor(detail: {
    code: string;
    message: string;
    missingFacts: string[];
    howToResolve: string;
  }) {
    super({
      message: detail.message,
      code: detail.code,
      missing_facts: detail.missingFacts,
      how_to_resolve: detail.howToResolve,
    });
    this.code = detail.code;
    this.missingFacts = detail.missingFacts;
    this.howToResolve = detail.howToResolve;
    // HttpException replaces `.message` for an object response; keep the real
    // sentence so non-HTTP callers (logs, triage) surface the actionable text.
    this.message = detail.message;
  }

  /** The refusal as one line a human can act on. */
  get actionableReason(): string {
    return `${this.message} How to resolve: ${this.howToResolve}`;
  }
}
