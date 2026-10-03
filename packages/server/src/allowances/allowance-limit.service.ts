import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely, sql } from 'kysely';
import { Database } from '../database/types';
import { NullCountryPlugin } from '../plugins/null-country.plugin';
import { OrgContextResolver } from '../organization/org-context.resolver';
import type { AllowanceType } from '../plugins/allowance-rates.types';
import type {
  CountryPlugin,
  OrgContext,
} from '../plugins/country-plugin.interface';
import type {
  FringeBenefitTax,
  HealthEligibilityFacts,
  HealthExemptionBasis,
} from '../plugins/health-allowance.types';
import {
  assertSingleWindow,
  assertYearMatchesPeriod,
  assessHealthEligibility,
  limitWindowBounds,
  limitWindowKey,
  bookedClaim,
} from './health-limit';
import { splitByMonth } from './date-utils';
import { UnresolvedHealthAllowanceError } from '../plugins/health-allowance.errors';

/** The currency every jurisdiction's health cap in this kernel is written in. */
export const HEALTH_LIMIT_CURRENCY = 'EUR';

/**
 * A read handle. The health path is called from INSIDE the posting transaction,
 * where the root `db` is unavailable (the SQLite dialect holds one connection,
 * so a root read during an open transaction deadlocks). Every read it makes
 * therefore goes through the executor it was handed.
 */
export type Executor = Kysely<Database>;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ComputeSplitParams {
  claimantId: number;
  type: AllowanceType;
  /** days: required for daily_allowance */
  days?: number;
  /** km: required for mileage */
  km?: number;
  /** inputAmount: required for phone/internet/health */
  inputAmount?: number;
  /** YYYY-MM-DD; for mileage this is the single service date */
  periodStart: string;
  /** YYYY-MM-DD; for daily_allowance end of trip */
  periodEnd?: string;
  domestic: boolean;
  year: number;
  /** ID of the Allowance being recalculated — excluded from accumulated sum to avoid self-counting */
  excludeAllowanceId?: number;
  /**
   * health only: the eligibility facts recorded on the claim. `null` means the
   * claim records none — a legacy row — which is NOT the same as recording
   * facts that fail, and is never read as qualifying.
   */
  healthFacts?: HealthEligibilityFacts | null;
}

/**
 * What a health claim's split was DECIDED on (issue #212): the basis, the
 * window the allocation was made against, and the employer's own tax on any
 * taxable excess. Persisted with the split and projected into the voucher, so
 * the row, the ledger and the report can never disagree about it.
 */
export interface HealthSplitDetail {
  exemptionBasis: HealthExemptionBasis;
  /** One sentence naming why, for the audit trail. */
  reason: string;
  /** '2026' | '2024-Q3' — null when no exemption regime applied at all. */
  limitWindow: string | null;
  /** The cap and what earlier POSTED claims had already consumed of it. */
  capPerClaimant: number | null;
  usedBeforeThisClaim: number;
  /** The employer's fringe-benefit tax on the taxable excess, if any. */
  fringeTax: FringeBenefitTax | null;
}

export interface MonthSegment {
  month: string; // 'YYYY-MM'
  days: number;
  /** Days at the high rate (75€/day, ≤15/month). NOT all tax-free days — use days - fallbackDays for that. */
  highRateDays: number;
  /** Days beyond the 15/month high-rate quota, paid at 40€/day — still 100% tax-free (TuMS) */
  fallbackDays: number;
  taxFreeAmount: number; // cents
  taxableAmount: number; // cents — always 0 for daily_allowance; only mileage can have taxable
  accumulatedDaysBefore: number;
}

export interface AllowanceSplit {
  grossAmount: number;
  taxFreeAmount: number;
  taxableAmount: number;
  breakdown: MonthSegment[]; // empty for mileage/phone/internet/health
  /** health only — how the split was decided and what tax the excess carries. */
  health?: HealthSplitDetail;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable()
export class AllowanceLimitService {
  constructor(
    @InjectKysely() private readonly db: Kysely<Database>,
    private readonly countryPlugin: NullCountryPlugin,
    private readonly orgContextResolver: OrgContextResolver,
  ) {}

  /**
   * @param executor - read handle. Pass the posting transaction when the split
   *   is being decided inside it; omit it for a preview off the root db.
   */
  async computeSplit(
    params: ComputeSplitParams,
    executor?: Executor,
  ): Promise<AllowanceSplit> {
    const { type } = params;
    // ONE handle for every read this call makes. Every type's accumulation
    // query goes through it, not only health's: an allowance is now approved
    // inside a transaction, and any read that still went to the root `db` from
    // in there would wait forever on the connection the transaction holds.
    const read = executor ?? this.db;

    if (type === 'daily_allowance') {
      return this.computeDailyAllowanceSplit(params, read);
    }
    if (type === 'mileage') {
      return this.computeMileageSplit(params, read);
    }
    if (type === 'health') {
      return this.computeHealthSplit(params, read);
    }
    // phone, internet — employer-defined, no statutory ceiling
    return this.computeFixedInputSplit(params);
  }

  // -------------------------------------------------------------------------
  // health — statutory exemption, per-claimant, per-window (issue #212)
  // -------------------------------------------------------------------------

  /**
   * Health/sports reimbursement used to fall through to
   * {@link computeFixedInputSplit} alongside phone and internet, which calls
   * the whole input amount tax-free and reads no accumulated usage. That is
   * wrong in both directions: the exemption is CAPPED per claimant per window,
   * and it is CONDITIONAL — a claim that does not satisfy the conditions is not
   * partly exempt, it is taxable in full.
   *
   * Everything is decided from the claim's own authoritative date: which rules
   * were in force, which window the cap accumulates in, and which tax rates the
   * excess carries. Nothing is decided from today's rules or from a
   * caller-supplied year that disagrees with the claim.
   *
   * Only POSTED claims consume the cap. A draft reserves nothing and a rejected
   * or cancelled one frees nothing, because neither ever took anything: the
   * split a draft shows is a PREVIEW, and the authoritative allocation happens
   * once, inside the transaction that posts the voucher. Two approvals racing
   * for the same remaining cents therefore cannot both take them — the second
   * reads the first's committed usage.
   */
  private async computeHealthSplit(
    params: ComputeSplitParams,
    executor: Executor,
  ): Promise<AllowanceSplit> {
    const {
      claimantId,
      inputAmount,
      periodStart,
      periodEnd,
      year,
      excludeAllowanceId,
      healthFacts,
    } = params;

    const grossAmount = inputAmount ?? 0;

    assertYearMatchesPeriod(periodStart, year);

    const { plugin, orgContext } =
      await this.orgContextResolver.resolve(executor);
    const rules = plugin.getHealthAllowanceRules(periodStart);

    // No exemption regime on this date: the benefit is taxable in full. This is
    // the honest reading of "this jurisdiction/vintage has no such exemption" —
    // not "no ceiling applies".
    if (!rules) {
      return this.healthResult(
        grossAmount,
        0,
        {
          exemptionBasis: 'no_statutory_exemption',
          reason:
            `No health or sports exemption applied on ${periodStart} in ` +
            `${orgContext.country}, so the whole benefit is taxable.`,
          limitWindow: null,
          capPerClaimant: null,
          usedBeforeThisClaim: 0,
          fringeTax: null,
        },
        plugin,
        periodStart,
        orgContext,
      );
    }

    // The cap is a figure in the law's own currency. An organisation keeping
    // its books in another one cannot be measured against it by treating the
    // number as currency-agnostic: 400 units of a different currency is not
    // EUR 400, and silently spending one cap as if it were the other would
    // exempt an arbitrary amount. There is no recorded rate policy for
    // translating a statutory ceiling, so this is refused, not converted.
    const baseCurrency =
      orgContext.baseCurrency ?? plugin.getDefaultBaseCurrency();
    if (baseCurrency !== HEALTH_LIMIT_CURRENCY) {
      throw new UnresolvedHealthAllowanceError({
        code: 'health_limit_currency_mismatch',
        message:
          `The health exemption is a ${HEALTH_LIMIT_CURRENCY} figure ` +
          `(${rules.legalBasis}), but this organisation keeps its books in ` +
          `${baseCurrency}. Nothing records how a statutory ceiling should be ` +
          `translated between the two, so the claim was not classified.`,
        missingFacts: [
          `organization.base_currency=${baseCurrency} vs a limit denominated in ${HEALTH_LIMIT_CURRENCY}`,
        ],
        howToResolve:
          `Translating a statutory ceiling into another currency is not ` +
          `supported, and the books' currency must not be changed to work ` +
          `around that — it would restate everything already posted in them. ` +
          `Take this claim to an accountant: either it belongs in a set of ` +
          `books kept in ${HEALTH_LIMIT_CURRENCY}, or the exemption has to be ` +
          `applied by hand against a rate they decide and record.`,
      });
    }

    assertSingleWindow(periodStart, periodEnd, rules.windowKind);

    const verdict = assessHealthEligibility(healthFacts ?? null, rules);
    const limitWindow = limitWindowKey(periodStart, rules.windowKind);

    if (!verdict.eligible) {
      return this.healthResult(
        grossAmount,
        0,
        {
          exemptionBasis: verdict.basis,
          reason: verdict.reason,
          limitWindow,
          capPerClaimant: rules.capPerClaimant,
          usedBeforeThisClaim: 0,
          fringeTax: null,
        },
        plugin,
        periodStart,
        orgContext,
      );
    }

    const bounds = limitWindowBounds(periodStart, rules.windowKind);

    // Sum what earlier BOOKED health claims of THIS claimant already took from
    // this window's cap — see `bookedClaim`. A draft or a pending claim has
    // reserved nothing, and a rejected one never held anything to release; a
    // claim whose voucher is posted holds its share for good, whatever its row
    // status is later set to, and a reversal does not quietly hand it back.
    const usedRow = await executor
      .selectFrom('allowance')
      .select(({ fn }) => [fn.sum<number>('tax_free_amount').as('total')])
      .where('claimant_id', '=', claimantId)
      .where('type', '=', 'health')
      .where(bookedClaim)
      .where('period_start', '>=', bounds.start)
      .where('period_start', '<=', bounds.end)
      .where('id', '!=', excludeAllowanceId ?? -1)
      .executeTakeFirst();

    const used = Number(usedRow?.total ?? 0) || 0;
    const remaining = Math.max(0, rules.capPerClaimant - used);
    const taxFreeAmount = Math.min(grossAmount, remaining);

    return this.healthResult(
      grossAmount,
      taxFreeAmount,
      {
        exemptionBasis:
          taxFreeAmount > 0 ? 'statutory_health_exemption' : 'limit_exhausted',
        reason:
          taxFreeAmount > 0
            ? `${rules.legalBasis}; ${used} of ${rules.capPerClaimant} already used in ${limitWindow}.`
            : `The ${limitWindow} exemption of ${rules.capPerClaimant} was already fully used (${used}), so this claim is taxable in full.`,
        limitWindow,
        capPerClaimant: rules.capPerClaimant,
        usedBeforeThisClaim: used,
        fringeTax: null,
      },
      plugin,
      periodStart,
      orgContext,
    );
  }

  /**
   * Assemble the split and, when any of it is taxable, ask the plugin for the
   * employer's tax on that excess. The tax is resolved HERE rather than at
   * projection time so the persisted row, the posted voucher and the report all
   * read the same numbers from one decision.
   */
  private healthResult(
    grossAmount: number,
    taxFreeAmount: number,
    detail: HealthSplitDetail,
    plugin: CountryPlugin,
    date: string,
    orgContext: OrgContext,
  ): AllowanceSplit {
    const taxableAmount = grossAmount - taxFreeAmount;
    const fringeTax =
      taxableAmount > 0
        ? plugin.resolveFringeBenefitTax(taxableAmount, date, orgContext)
        : null;

    return {
      grossAmount,
      taxFreeAmount,
      taxableAmount,
      breakdown: [],
      health: { ...detail, fringeTax },
    };
  }

  // -------------------------------------------------------------------------
  // daily_allowance
  // -------------------------------------------------------------------------

  private async computeDailyAllowanceSplit(
    params: ComputeSplitParams,
    executor: Executor,
  ): Promise<AllowanceSplit> {
    const {
      claimantId,
      days,
      periodStart,
      periodEnd,
      domestic,
      year,
      excludeAllowanceId,
    } = params;

    const rates = this.countryPlugin.getAllowanceRates(
      'daily_allowance',
      year,
      {
        domestic,
      },
    );

    const ratePerUnit = rates.ratePerUnit;
    const fallbackRatePerUnit = rates.fallbackRatePerUnit ?? 0;
    const highRateDaysPerMonth = rates.highRateDaysPerMonth ?? 0;

    // Split trip into calendar-month segments
    const end = periodEnd ?? periodStart;
    const segments = splitByMonth(periodStart, end);

    // If the caller gave an explicit days count but we have multiple segments,
    // we distribute the days proportionally by segment length as computed by splitByMonth.
    // The total days from splitByMonth must equal params.days (if provided).
    // When params.days is not provided, we use the segment days from splitByMonth.
    const totalDaysFromSplit = segments.reduce((s, seg) => s + seg.days, 0);
    const totalDays = days ?? totalDaysFromSplit;

    // Scale factor in case caller's days != days computed from date range
    // (e.g. overnight trip counting partial days differently). Default: use split as-is.
    const scaleFactor =
      totalDaysFromSplit > 0 ? totalDays / totalDaysFromSplit : 1;

    const breakdown: MonthSegment[] = [];
    let totalGross = 0;
    let totalTaxFree = 0;
    let totalTaxable = 0;

    for (const seg of segments) {
      const segDays = Math.round(seg.days * scaleFactor);
      const monthKey = seg.month; // 'YYYY-MM'

      // Query accumulated days already used for THIS calendar month. Sum the
      // per-month day counts stored in each allowance's `breakdown` JSON via
      // SQLite json_each — NOT the top-level `days` column anchored on
      // period_start. A trip spanning June→July is one row with period_start in
      // June and a `breakdown` carrying both [{month:'2026-06',days:..},
      // {month:'2026-07',days:..}]; bucketing by period_start would credit all
      // its days to June and miss the July days entirely (under-counting July's
      // consumed quota). json_each($.month) attributes each segment's days to
      // its own calendar month.
      const excludeId = excludeAllowanceId ?? null;
      const accRow = await sql<{ accumulated_days: number }>`
        SELECT COALESCE(SUM(CAST(json_extract(b.value, '$.days') AS INTEGER)), 0) AS accumulated_days
        FROM allowance a, json_each(a.breakdown) b
        WHERE a.claimant_id = ${claimantId}
          AND a.type = 'daily_allowance'
          AND a.status NOT IN ('rejected', 'cancelled', 'draft')
          AND json_extract(b.value, '$.month') = ${monthKey}
          AND (${excludeId} IS NULL OR a.id != ${excludeId})
      `.execute(executor);

      const accDays = Number(accRow.rows[0]?.accumulated_days ?? 0) || 0;

      // How many high-rate days remain for this month?
      const remaining = Math.max(0, highRateDaysPerMonth - accDays);
      const highDays = Math.min(segDays, remaining);
      const lowDays = segDays - highDays;

      // Both the high-rate (75€/day, first 15 days/month) and the fallback-rate
      // (40€/day, beyond 15 days/month) are 100% tax-free statutory rates under TuMS.
      // taxableAmount is always 0 for daily_allowance.
      const segHighRateAmount = highDays * ratePerUnit;
      const segFallbackAmount = lowDays * fallbackRatePerUnit;
      const segGross = segHighRateAmount + segFallbackAmount;
      const segTaxFree = segGross;
      const segTaxable = 0;

      breakdown.push({
        month: monthKey,
        days: segDays,
        highRateDays: highDays,
        fallbackDays: lowDays,
        taxFreeAmount: segTaxFree,
        taxableAmount: segTaxable,
        accumulatedDaysBefore: accDays,
      });

      totalGross += segGross;
      totalTaxFree += segTaxFree;
      totalTaxable += segTaxable;
    }

    return {
      grossAmount: totalGross,
      taxFreeAmount: totalTaxFree,
      taxableAmount: totalTaxable,
      breakdown,
    };
  }

  // -------------------------------------------------------------------------
  // mileage
  // -------------------------------------------------------------------------

  private async computeMileageSplit(
    params: ComputeSplitParams,
    executor: Executor,
  ): Promise<AllowanceSplit> {
    const { claimantId, km, periodStart, year, domestic, excludeAllowanceId } =
      params;

    const rates = this.countryPlugin.getAllowanceRates('mileage', year, {
      domestic,
    });

    const ratePerUnit = rates.ratePerUnit; // cents per km
    const monthlyTaxFreeCeiling = rates.monthlyTaxFreeCeiling; // cents; null = no ceiling

    const grossAmount = (km ?? 0) * ratePerUnit;

    if (monthlyTaxFreeCeiling === null) {
      // No ceiling — fully tax-free
      return {
        grossAmount,
        taxFreeAmount: grossAmount,
        taxableAmount: 0,
        breakdown: [],
      };
    }

    // Determine the calendar month from periodStart
    const monthKey = periodStart.slice(0, 7); // 'YYYY-MM'
    const year4 = parseInt(monthKey.slice(0, 4), 10);
    const month1based = parseInt(monthKey.slice(5, 7), 10);

    // First day of this month
    const monthStart = `${monthKey}-01`;

    // First day of next month
    const nextMonthDate = new Date(Date.UTC(year4, month1based, 1));
    const nextMonthStart = nextMonthDate.toISOString().slice(0, 10);

    // Accumulated tax-free mileage amount for this month
    const accRow = await executor
      .selectFrom('allowance')
      .select(({ fn }) => [fn.sum<number>('tax_free_amount').as('total')])
      .where('claimant_id', '=', claimantId)
      .where('type', '=', 'mileage')
      .where('period_start', '>=', monthStart)
      .where('period_start', '<', nextMonthStart)
      .where('status', '!=', 'rejected')
      .where('status', '!=', 'cancelled')
      .where('id', '!=', excludeAllowanceId ?? -1)
      .executeTakeFirst();

    const accAmount = Number(accRow?.total ?? 0) || 0;

    const remainingTaxFree = Math.max(0, monthlyTaxFreeCeiling - accAmount);
    const taxFreeAmount = Math.min(grossAmount, remainingTaxFree);
    const taxableAmount = grossAmount - taxFreeAmount;

    return {
      grossAmount,
      taxFreeAmount,
      taxableAmount,
      breakdown: [],
    };
  }

  // -------------------------------------------------------------------------
  // phone / internet / health — employer-defined, no statutory ceiling
  // -------------------------------------------------------------------------

  private async computeFixedInputSplit(
    params: ComputeSplitParams,
  ): Promise<AllowanceSplit> {
    const { inputAmount } = params;
    const grossAmount = inputAmount ?? 0;
    return {
      grossAmount,
      taxFreeAmount: grossAmount,
      taxableAmount: 0,
      breakdown: [],
    };
  }
}
