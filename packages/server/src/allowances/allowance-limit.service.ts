import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely, sql } from 'kysely';
import { Database } from '../database/types';
import { NullCountryPlugin } from '../plugins/null-country.plugin';
import type { AllowanceType } from '../plugins/allowance-rates.types';
import { splitByMonth } from './date-utils';

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
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable()
export class AllowanceLimitService {
  constructor(
    @InjectKysely() private readonly db: Kysely<Database>,
    private readonly countryPlugin: NullCountryPlugin,
  ) {}

  async computeSplit(params: ComputeSplitParams): Promise<AllowanceSplit> {
    const { type } = params;

    if (type === 'daily_allowance') {
      return this.computeDailyAllowanceSplit(params);
    }
    if (type === 'mileage') {
      return this.computeMileageSplit(params);
    }
    // phone, internet, health — employer-defined, no statutory ceiling
    return this.computeFixedInputSplit(params);
  }

  // -------------------------------------------------------------------------
  // daily_allowance
  // -------------------------------------------------------------------------

  private async computeDailyAllowanceSplit(
    params: ComputeSplitParams,
  ): Promise<AllowanceSplit> {
    const { claimantId, days, periodStart, periodEnd, domestic, year, excludeAllowanceId } =
      params;

    const rates = this.countryPlugin.getAllowanceRates('daily_allowance', year, {
      domestic,
    });

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
    const scaleFactor = totalDaysFromSplit > 0 ? totalDays / totalDaysFromSplit : 1;

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
      `.execute(this.db);

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
  ): Promise<AllowanceSplit> {
    const { claimantId, km, periodStart, year, domestic, excludeAllowanceId } = params;

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
    const accRow = await this.db
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
