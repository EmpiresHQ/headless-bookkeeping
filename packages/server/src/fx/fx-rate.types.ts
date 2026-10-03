import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * The FX rate seam (issue #203).
 *
 * A reference rate is an OBSERVATION published by an authority for a specific
 * date — never a constant. This file defines the narrow boundary through which
 * such observations enter the system, so that:
 *
 *   - production reads them from a real authority (the ECB, see
 *     {@link EcbFxRateSource}), and
 *   - tests inject deterministic fixtures AT THIS BOUNDARY, rather than
 *     smuggling test constants into the production posting path behind a flag.
 */

/** DI token for the active {@link FxRateSource}. */
export const FX_RATE_SOURCE = 'FX_RATE_SOURCE';

/**
 * One published observation: on `rateDate`, the authority published that
 * 1 `baseCurrency` buys `rate` units of `quoteCurrency`.
 *
 * The ECB quotes euro reference rates this way (1 EUR = 1.1193 USD on
 * 2020-01-02), so the convention is the authority's own, stored unmodified.
 * Any inversion or cross-rate is derived later, explicitly, by
 * {@link FxRateService} — never baked into what we persist as observed.
 */
export interface FxObservation {
  /** The currency 1 unit of which the rate prices (ECB: always "EUR"). */
  baseCurrency: string;
  /** The priced currency (e.g. "USD"). */
  quoteCurrency: string;
  /** The publication date the observation belongs to (YYYY-MM-DD). */
  rateDate: string;
  /** Units of `quoteCurrency` per 1 `baseCurrency`. Strictly positive. */
  rate: number;
}

/**
 * The upstream authority. Deliberately tiny: fetch every observation the
 * authority published for one quote currency over a closed date window.
 *
 * Implementations MUST NOT be called from inside a SQLite transaction —
 * better-sqlite3 runs one synchronous connection, so an awaited network round
 * trip inside an open transaction deadlocks the process. {@link FxRateService}
 * is the only caller and is always invoked from pre-transaction code.
 */
export interface FxRateSource {
  /** Stable identifier persisted as the rate's provenance (e.g. "ECB"). */
  readonly sourceId: string;

  /** The currency the source quotes against (ECB: "EUR"). */
  readonly baseCurrency: string;

  /**
   * Every observation published for `quoteCurrency` with
   * `fromDate <= rateDate <= toDate`, ascending. An empty array means the
   * authority published nothing in that window (a holiday run) — NOT an error.
   *
   * @throws {FxRateUnavailableError} when the pair is not quoted at all, or the
   *   authority could not be reached / answered unusably.
   */
  fetchObservations(
    quoteCurrency: string,
    fromDate: string,
    toDate: string,
  ): Promise<FxObservation[]>;
}

/**
 * A rate actually applied to a conversion, with the provenance that makes the
 * result reproducible: WHICH date's publication was used (which is not always
 * the transaction date — see the non-publication fallback) and WHO published it.
 */
export interface ResolvedFxRate {
  /** Units of the target currency per 1 unit of the source currency. */
  rate: number;
  /** The publication date the rate was taken from (YYYY-MM-DD). */
  rateDate: string;
  /** The provenance identifier, persisted alongside the rate. */
  source: string;
}

/**
 * Provenance marker for a conversion that needed no rate at all: the amount was
 * already in the target currency. Persisted explicitly (rather than left NULL)
 * so an identity conversion stays distinguishable from a legacy line posted
 * before provenance existed.
 */
export const IDENTITY_RATE_SOURCE = 'identity';

/**
 * Provenance marker for a rate taken from the bank's OWN statement data rather
 * than from a reference authority. Realized FX is the gap between the booked
 * reference value and the actual cash (ADR-0004, Wave-5): the cash leg's rate
 * is the bank's, and must not be mistaken for an ECB observation.
 */
export const BANK_STATEMENT_RATE_SOURCE = 'bank_statement';

/**
 * Why no rate could be established. The distinction is actionable, not
 * decorative: an operator retries an outage and does something else entirely
 * about a currency the authority does not quote.
 */
export type FxRateUnavailableReason =
  /** The authority does not quote this pair at all. Retrying will not help. */
  | 'unsupported_pair'
  /** The authority quotes the pair, but published nothing governing this date. */
  | 'no_rate_for_date'
  /** The authority could not be reached, or answered unusably. Retryable. */
  | 'upstream_unavailable'
  /** The wiring disagrees with the plugin's declared policy. An operator fix. */
  | 'misconfigured';

/** Stable machine-readable discriminator on the HTTP body. */
export const FX_RATE_UNAVAILABLE_CODE = 'FX_RATE_UNAVAILABLE';

const STATUS_BY_REASON: Record<FxRateUnavailableReason, HttpStatus> = {
  // Well-formed request, but the conversion it asks for cannot be performed
  // from any authoritative source. Not the caller's syntax, not our fault,
  // not fixable by retrying — 422.
  unsupported_pair: HttpStatus.UNPROCESSABLE_ENTITY,
  no_rate_for_date: HttpStatus.UNPROCESSABLE_ENTITY,
  // A dependency is down. Same request may well succeed later — 503.
  upstream_unavailable: HttpStatus.SERVICE_UNAVAILABLE,
  misconfigured: HttpStatus.INTERNAL_SERVER_ERROR,
};

const RETRYABLE_BY_REASON: Record<FxRateUnavailableReason, boolean> = {
  unsupported_pair: false,
  no_rate_for_date: false,
  upstream_unavailable: true,
  misconfigured: false,
};

/**
 * No authoritative rate could be established for the requested pair and date.
 *
 * This is deliberately a hard failure with no fallback value. Acceptance
 * criterion (#203): when no supported rate is available the conversion is held
 * or rejected — never silently completed with a latest/current/constant rate,
 * which would post an unsupported base amount into an immutable ledger.
 *
 * It is an `HttpException` because a missing rate is an EXPECTED domain
 * outcome, not a crash. As a plain `Error` it fell through the catch-all
 * filter as an opaque 500 ("Internal server error"), which tells an operator
 * nothing about which pair, which date, or whether retrying would help — and
 * made intake log it as an unforeseen fault. Services in this codebase already
 * throw `BadRequestException` / `ConflictException` directly (PostingService,
 * PrepaymentService), so carrying the HTTP semantics on the domain error is
 * the established idiom here rather than a new coupling.
 *
 * The body is stable and machine-readable: `code`, `reason`, the pair, the
 * date and `retryable`. Nothing about it invites a fallback; it says what
 * could not be done and whether trying again is worthwhile.
 */
export class FxRateUnavailableError extends HttpException {
  readonly code = FX_RATE_UNAVAILABLE_CODE;
  readonly retryable: boolean;

  constructor(
    readonly fromCurrency: string,
    readonly toCurrency: string,
    readonly date: string,
    readonly detail: string,
    readonly reason: FxRateUnavailableReason = 'no_rate_for_date',
  ) {
    const message = `No authoritative FX rate for ${fromCurrency} → ${toCurrency} on ${date}: ${detail}`;
    const status = STATUS_BY_REASON[reason];
    super(
      {
        statusCode: status,
        error: 'FX rate unavailable',
        code: FX_RATE_UNAVAILABLE_CODE,
        reason,
        fromCurrency,
        toCurrency,
        date,
        retryable: RETRYABLE_BY_REASON[reason],
        message,
      },
      status,
    );
    this.name = 'FxRateUnavailableError';
    this.retryable = RETRYABLE_BY_REASON[reason];
  }
}
