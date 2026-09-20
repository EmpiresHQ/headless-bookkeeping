import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely } from 'kysely';
import { Database } from '../database/types';
import {
  FX_RATE_SOURCE,
  FxObservation,
  FxRateUnavailableError,
  IDENTITY_RATE_SOURCE,
  ResolvedFxRate,
} from './fx-rate.types';
// `import type`: FxRateSource appears only in a decorated constructor
// signature, and emitDecoratorMetadata would otherwise emit a runtime
// reference to a type-only export (TS1272 under isolatedModules).
import type { FxRateSource } from './fx-rate.types';

/**
 * How a non-publication day is resolved, declared by the CALLER (the country
 * plugin), because it is a jurisdiction rule and not a kernel constant
 * (ADR-0002).
 *
 * - `on-or-before`: use the newest publication at or before the requested
 *   date, looking back at most `maxLookbackDays`. This implements a statute
 *   that says the rate *in force* on the tax point applies (Estonia,
 *   KMS § 29 lg 13 — "määratud päeval kehtivat ... kurssi"), since a published
 *   rate stays in force until the next publication.
 * - `exact`: only a publication dated exactly on the requested date counts.
 */
export interface FxLookupPolicy {
  /** The authority whose publications govern (must match the wired source). */
  source: string;
  fallback: 'on-or-before' | 'exact';
  /**
   * The bound on the fallback. A rate from further back than this is not
   * "in force", it is stale, and the conversion is refused instead.
   */
  maxLookbackDays: number;
}

/**
 * FxRateService — turns a (pair, date) question into an authoritative,
 * reproducible answer, or refuses.
 *
 * Responsibilities, and deliberately only these:
 *   1. the same-currency identity (never touches the source),
 *   2. reading the append-only observation cache,
 *   3. fetching from the injected {@link FxRateSource} on a cache miss and
 *      persisting what came back — OUTSIDE any SQLite transaction,
 *   4. the bounded non-publication fallback declared by the policy, and
 *   5. the direction / cross-rate arithmetic from the authority's own
 *      quotation convention.
 *
 * It does NOT decide which authority governs, how far back a rate stays in
 * force, or what to do when none is available: those are the country plugin's
 * (ADR-0002/ADR-0004), expressed as an {@link FxLookupPolicy}.
 *
 * TRANSACTION SAFETY: every method here may perform a network round trip and
 * a write. better-sqlite3 runs one synchronous connection, so calling this
 * from inside an open transaction would deadlock. All callers resolve rates in
 * the pre-transaction phase, which is the pattern the posting path already
 * follows for account resolution and validation.
 */
@Injectable()
export class FxRateService {
  private readonly logger = new Logger(FxRateService.name);

  constructor(
    @InjectKysely() private readonly db: Kysely<Database>,
    @Inject(FX_RATE_SOURCE) private readonly source: FxRateSource,
  ) {}

  /**
   * The rate to apply when converting `fromCurrency` into `toCurrency` for a
   * transaction dated `date`: how many `toCurrency` units 1 `fromCurrency`
   * unit buys, with the provenance that makes the figure reproducible.
   *
   * @throws {FxRateUnavailableError} when no authoritative rate governs. There
   *   is no fallback value — a held conversion is correct, an invented base
   *   amount is not (#203 acceptance).
   */
  async resolve(
    fromCurrency: string,
    toCurrency: string,
    date: string,
    policy: FxLookupPolicy,
  ): Promise<ResolvedFxRate> {
    if (fromCurrency === toCurrency) {
      return { rate: 1.0, rateDate: date, source: IDENTITY_RATE_SOURCE };
    }

    if (policy.source !== this.source.sourceId) {
      throw new FxRateUnavailableError(
        fromCurrency,
        toCurrency,
        date,
        `policy requires source "${policy.source}" but "${this.source.sourceId}" is wired`,
      );
    }

    const anchor = this.source.baseCurrency;

    // The authority quotes everything against ONE currency (the ECB: EUR), so
    // every pair is at most two of its quotations. Directions, spelled out:
    //   anchor → X : the quotation itself           (1 EUR = 1.09 USD)
    //   X → anchor : its reciprocal                 (1 USD = 1/1.09 EUR)
    //   X → Y      : the cross, anchor cancelling   (1 USD = (1/1.09) × 0.86 GBP)
    // A cross uses ONE date for both legs — the same publication — so the two
    // quotations are consistent with each other and the anchor really cancels.
    if (fromCurrency === anchor) {
      const obs = await this.observation(toCurrency, date, policy);
      return { rate: obs.rate, rateDate: obs.rateDate, source: obs.source };
    }

    if (toCurrency === anchor) {
      const obs = await this.observation(fromCurrency, date, policy);
      return { rate: 1 / obs.rate, rateDate: obs.rateDate, source: obs.source };
    }

    const from = await this.observation(fromCurrency, date, policy);
    const to = await this.observation(toCurrency, date, policy);
    if (from.rateDate !== to.rateDate) {
      // Both legs exist but on different publication days. Crossing them would
      // mix two days' markets into one rate that the authority never
      // published, so it is refused rather than approximated.
      throw new FxRateUnavailableError(
        fromCurrency,
        toCurrency,
        date,
        `cross rate would mix publications of ${from.rateDate} and ${to.rateDate}`,
      );
    }
    return {
      rate: to.rate / from.rate,
      rateDate: from.rateDate,
      source: from.source,
    };
  }

  /**
   * One leg: the governing `anchor → quoteCurrency` quotation for `date`.
   *
   * The order matters, and is not "cache, else fetch". A cached observation
   * dated Friday says nothing about whether Monday was published — so serving
   * a Monday question from it, merely because Monday has no row, would hand
   * back a Friday rate for every date in the lookback window and quietly
   * recreate the date-blind behaviour this issue removes.
   *
   * So the cache is consulted only for a date some PROBE covers, i.e. one the
   * authority has actually been asked about over the whole lookback window.
   * Otherwise we go upstream first, and only then apply the fallback.
   */
  private async observation(
    quoteCurrency: string,
    date: string,
    policy: FxLookupPolicy,
  ): Promise<{ rate: number; rateDate: string; source: string }> {
    const earliest =
      policy.fallback === 'exact'
        ? date
        : shiftDate(date, -policy.maxLookbackDays);

    if (await this.isProbed(quoteCurrency, earliest, date, policy)) {
      const cached = await this.readCache(
        quoteCurrency,
        earliest,
        date,
        policy,
      );
      if (cached) {
        return cached;
      }
      // Probed and genuinely empty: the authority published nothing in the
      // window. Refuse — do not widen the window looking for something older.
      throw this.unavailable(quoteCurrency, date, policy);
    }

    const fetched = await this.source.fetchObservations(
      quoteCurrency,
      earliest,
      date,
    );
    await this.persist(fetched);
    await this.recordProbe(quoteCurrency, earliest, date);

    const resolved = await this.readCache(
      quoteCurrency,
      earliest,
      date,
      policy,
    );
    if (!resolved) {
      throw this.unavailable(quoteCurrency, date, policy);
    }
    return resolved;
  }

  private unavailable(
    quoteCurrency: string,
    date: string,
    policy: FxLookupPolicy,
  ): FxRateUnavailableError {
    return new FxRateUnavailableError(
      this.source.baseCurrency,
      quoteCurrency,
      date,
      policy.fallback === 'exact'
        ? `${this.source.sourceId} published no rate on ${date}`
        : `${this.source.sourceId} published no rate on ${date} nor in the ` +
            `${policy.maxLookbackDays} day(s) before it`,
    );
  }

  /** Has the whole window [earliest, date] already been asked about? */
  private async isProbed(
    quoteCurrency: string,
    earliest: string,
    date: string,
    policy: FxLookupPolicy,
  ): Promise<boolean> {
    const row = await this.db
      .selectFrom('fx_rate_probe')
      .select('id')
      .where('source', '=', policy.source)
      .where('base_currency', '=', this.source.baseCurrency)
      .where('quote_currency', '=', quoteCurrency)
      .where('from_date', '<=', earliest)
      .where('to_date', '>=', date)
      .limit(1)
      .executeTakeFirst();
    return row !== undefined;
  }

  /**
   * Record that [from, to] has been asked about — but never past yesterday.
   *
   * Today is not a settled day: the ECB publishes around 16:00 CET, so a fetch
   * at 10:00 legitimately finds nothing for today. Recording that as coverage
   * would pin "nothing published today" for the rest of the day and keep
   * serving yesterday's rate to NEW postings even after today's publication
   * appears. Clamping to yesterday makes a same-day answer provisional: it is
   * re-fetched until the day closes.
   *
   * Vouchers already posted are untouched by this — each carries the rate and
   * publication date it was booked at, and a posted line is immutable
   * (ADR-0019). Two postings dated today, on either side of 16:00 CET, may
   * legitimately carry different `fx_rate_date`s; the provenance says so
   * rather than hiding it.
   */
  private async recordProbe(
    quoteCurrency: string,
    from: string,
    to: string,
  ): Promise<void> {
    const yesterday = shiftDate(new Date().toISOString().slice(0, 10), -1);
    const settledTo = to <= yesterday ? to : yesterday;
    if (settledTo < from) {
      return;
    }
    await this.db
      .insertInto('fx_rate_probe')
      .values({
        source: this.source.sourceId,
        base_currency: this.source.baseCurrency,
        quote_currency: quoteCurrency,
        from_date: from,
        to_date: settledTo,
        probed_at: Math.floor(Date.now() / 1000),
      })
      .execute();
  }

  /** The newest cached publication within [earliest, date], or null. */
  private async readCache(
    quoteCurrency: string,
    earliest: string,
    date: string,
    policy: FxLookupPolicy,
  ): Promise<{ rate: number; rateDate: string; source: string } | null> {
    const row = await this.db
      .selectFrom('fx_reference_rate')
      .select(['rate', 'rate_date', 'source'])
      .where('source', '=', policy.source)
      .where('base_currency', '=', this.source.baseCurrency)
      .where('quote_currency', '=', quoteCurrency)
      .where('rate_date', '<=', date)
      .where('rate_date', '>=', earliest)
      .orderBy('rate_date', 'desc')
      .limit(1)
      .executeTakeFirst();

    return row
      ? { rate: row.rate, rateDate: row.rate_date, source: row.source }
      : null;
  }

  /**
   * Insert observations the cache does not already hold.
   *
   * `onConflict().doNothing()` is the load-bearing part: an observation we
   * already stored is never replaced. If the authority later revises a figure
   * we have posted against, the revision does not silently revalue history —
   * the posted vouchers stay explicable by the stored evidence, and the
   * divergence is logged so it can be handled as an append-only correction.
   */
  private async persist(observations: FxObservation[]): Promise<void> {
    if (observations.length === 0) {
      return;
    }
    const now = Math.floor(Date.now() / 1000);
    for (const obs of observations) {
      const existing = await this.db
        .selectFrom('fx_reference_rate')
        .select('rate')
        .where('source', '=', this.source.sourceId)
        .where('base_currency', '=', obs.baseCurrency)
        .where('quote_currency', '=', obs.quoteCurrency)
        .where('rate_date', '=', obs.rateDate)
        .executeTakeFirst();

      if (existing) {
        if (existing.rate !== obs.rate) {
          this.logger.warn(
            `${this.source.sourceId} now reports ${obs.rate} for ` +
              `${obs.baseCurrency}/${obs.quoteCurrency} on ${obs.rateDate}, ` +
              `cached ${existing.rate}. Keeping the cached observation: ` +
              `vouchers already posted against it must stay reproducible. ` +
              `Correct any affected posting with a correction voucher.`,
          );
        }
        continue;
      }

      await this.db
        .insertInto('fx_reference_rate')
        .values({
          source: this.source.sourceId,
          base_currency: obs.baseCurrency,
          quote_currency: obs.quoteCurrency,
          rate_date: obs.rateDate,
          rate: obs.rate,
          fetched_at: now,
        })
        .onConflict((oc) => oc.doNothing())
        .execute();
    }
  }
}

/** Shift a YYYY-MM-DD date by whole days, in UTC (no local-timezone drift). */
function shiftDate(date: string, days: number): string {
  const ms = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(ms)) {
    throw new Error(`Invalid date "${date}" (expected YYYY-MM-DD)`);
  }
  return new Date(ms + days * 86_400_000).toISOString().slice(0, 10);
}
