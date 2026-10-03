import { UnprocessableEntityException } from '@nestjs/common';

/**
 * The facts needed to classify a supply are missing or conflicting, so NOTHING
 * is posted (issue #209).
 *
 * A VAT treatment that cannot be derived from recorded facts must never be
 * invented. The kernel's two existing escapes — hold for Approval, or book
 * conservatively — both still produce a NUMBER on a return that the facts do
 * not support. For place-of-supply the honest answer is to refuse, name the
 * fact, and say exactly how to supply it, before any voucher exists. There is
 * no partial posting to unwind and no logged override that can silently bless
 * a guess: a semantic override relaxes a RULE, and this is an absent FACT.
 *
 * Carried as a 422 so every entry point (direct post, approval, correction,
 * AI-proposed draft) refuses identically without each one re-mapping it.
 */
export class UnresolvedVatTreatmentError extends UnprocessableEntityException {
  /** Stable machine code, e.g. 'customer_tax_status_unknown'. */
  readonly code: string;
  /** The facts that are missing or contradictory. */
  readonly missingFacts: string[];
  /** The supported call that supplies them. */
  readonly howToResolve: string;

  constructor(detail: {
    code: string;
    /** What could not be decided, in one sentence. */
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
    // HttpException sets a generic message for an object response; keep the
    // real sentence on `.message` so non-HTTP callers (intake triage, logs)
    // surface the actionable text rather than "Unprocessable Entity".
    this.message = detail.message;
  }

  /** The refusal as one line a human can act on. */
  get actionableReason(): string {
    return `${this.message} How to resolve: ${this.howToResolve}`;
  }
}
