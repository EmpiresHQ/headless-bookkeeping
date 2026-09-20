import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely } from 'kysely';
import { Database } from '../database/types';
import { OrgContextResolver } from '../organization/org-context.resolver';
import { bookedClaim } from './health-limit';

/** A single posted claim behind a reported figure, for the audit trail. */
export interface HealthBenefitClaimRef {
  allowanceId: number;
  claimantId: number;
  voucherId: number | null;
  periodStart: string;
  exemptAmount: number;
  taxableAmount: number;
  incomeTax: number;
  socialTax: number;
  exemptionBasis: string | null;
}

/** The two taxes, from one source. */
export interface FringeTaxPair {
  incomeTax: number;
  socialTax: number;
}

/**
 * One month's fringe-benefit declaration line: TSD annex 4, benefit code 4120
 * (health/sports expenditure exceeding the tax-exempt limit).
 */
export interface HealthBenefitMonth {
  /** 'YYYY-MM' — the month the benefit was given. */
  month: string;
  /** The taxable benefit value declared under code 4120, in minor units. */
  benefitValue: number;
  /** What the LEDGER holds: the per-claim taxes, as posted. */
  ledgerTax: FringeTaxPair;
  /** What the declaration's own arithmetic gives on the month's total. */
  declarationTax: FringeTaxPair;
  /**
   * declaration − ledger. Zero in the ordinary case. Non-zero when per-claim
   * rounding and whole-month rounding land a cent apart, which they can: two
   * 2.00 benefits round to 0.56 + 0.56 = 1.12 of income tax individually and to
   * 1.13 on 4.00 together. Neither figure is a mistake; they are answers to two
   * different questions, and the difference is shown rather than hidden.
   */
  roundingAdjustment: FringeTaxPair;
  /** Distinct claimants behind the month's benefits. */
  claimants: number;
  /** TSD is due on the 10th of the following month. */
  dueDate: string;
  /** The posted claims this line is made of. */
  claims: HealthBenefitClaimRef[];
}

/** INF 14 part III: the tax-EXEMPT health/sports expenditure for the year. */
export interface HealthBenefitAnnualExempt {
  /** Total exempt amount, in minor units. */
  exemptTotal: number;
  /** Distinct employees the exempt total was paid for. */
  employees: number;
  /** INF 14 is due by 1 February of the following year. */
  dueDate: string;
  /** The posted claims the exempt total is made of. */
  claims: HealthBenefitClaimRef[];
}

/**
 * A posted claim this report cannot stand behind: it predates the exemption
 * accounting, so what it declared exempt was never measured against the cap.
 */
export interface UnresolvedHistoricalClaim extends HealthBenefitClaimRef {
  reason: string;
}

export interface HealthBenefitReport {
  year: number;
  tsdAnnex4: { benefitCode: string; months: HealthBenefitMonth[] };
  inf14PartIii: HealthBenefitAnnualExempt;
  /**
   * Claims posted before the exemption was accounted for. Their amounts are
   * INCLUDED in the totals above — they are in the books and the books are the
   * record — but they were classified by the code that exempted any amount, so
   * a figure resting on them is not one to file blind. v1 offers no correction
   * path for a posted allowance, so resolving one is an accountant's job
   * outside this API; the report's duty is to say which claims they are.
   */
  unresolvedHistoricalClaims: UnresolvedHistoricalClaim[];
  /**
   * False when anything above needs a human first: a historical claim with no
   * recorded basis, or a month whose ledger and declaration arithmetic differ.
   */
  readyToFile: boolean;
  /** What this report IS, and what still has to happen to it. */
  filingNotes: string[];
}

/** The TSD annex-4 benefit code for health and sports expenditure. */
const HEALTH_BENEFIT_CODE = '4120';

/**
 * HealthBenefitReportService — the accountable trail behind a health benefit
 * (issue #212).
 *
 * Deciding the taxable excess correctly is only half of the obligation: the
 * excess has to be DECLARED (TSD annex 4 under code 4120, by the 10th of the
 * following month) and the exempt part reported annually (INF 14 part III: the
 * total and the number of employees it was paid for, by 1 February). Without
 * this surface the numbers exist only inside vouchers, and somebody has to
 * reverse-engineer a declaration out of the ledger every month.
 *
 * Three things it refuses to do:
 *
 *  - report for a jurisdiction whose plugin has no such declaration. TSD and
 *    INF 14 are Estonian forms; rendering them for an organisation elsewhere
 *    would invent an obligation.
 *  - present claims posted before this accounting existed as if they had been
 *    measured against the cap. They are listed separately, and the report says
 *    it is not ready to file while any remain. Nothing in the posted ledger is
 *    rewritten to make the report look clean — a posted voucher is immutable,
 *    and a correction is a decision for a human with the facts.
 *  - claim a total is filed-ready when the per-claim taxes in the ledger and
 *    the whole-month arithmetic of the declaration disagree by rounding. Both
 *    figures are given, with the difference named.
 */
@Injectable()
export class HealthBenefitReportService {
  constructor(
    @InjectKysely() private readonly db: Kysely<Database>,
    private readonly orgContextResolver: OrgContextResolver,
  ) {}

  async report(year: number): Promise<HealthBenefitReport> {
    if (!Number.isInteger(year) || year < 1900 || year > 9999) {
      throw new BadRequestException(`Invalid year: ${String(year)}`);
    }

    const { plugin, orgContext } = await this.orgContextResolver.resolve();

    // Anchor the jurisdiction check on a date inside the reported year, not on
    // today: a year whose rules existed is reportable even if they later went.
    if (!plugin.getHealthAllowanceRules(`${year}-12-31`)) {
      throw new ConflictException(
        `${orgContext.country} had no health or sports benefit exemption in ` +
          `${year}, so there is no TSD annex 4 code ${HEALTH_BENEFIT_CODE} or ` +
          `INF 14 part III figure to report for it.`,
      );
    }

    const rows = await this.db
      .selectFrom('allowance')
      .select([
        'id',
        'claimant_id',
        'voucher_id',
        'period_start',
        'tax_free_amount',
        'taxable_amount',
        'fringe_income_tax_amount',
        'fringe_social_tax_amount',
        'exemption_basis',
      ])
      .where('type', '=', 'health')
      // The same rule the limit uses, so the report and the cap can never
      // disagree about which claims count: whatever is in the books.
      .where(bookedClaim)
      .where('period_start', '>=', `${year}-01-01`)
      .where('period_start', '<=', `${year}-12-31`)
      .orderBy('period_start')
      .orderBy('id')
      .execute();

    // Any voucher pointing back at a claim's voucher. Not proof the benefit was
    // undone — a reversal can be partial, and chains exist — which is exactly
    // why such a claim is flagged for a human instead of being netted off or
    // dropped from the totals by this report.
    const reversedVoucherIds = new Set(
      (
        await this.db
          .selectFrom('voucher')
          .select('reverses_id')
          .where('reverses_id', 'is not', null)
          .execute()
      ).map((v) => v.reverses_id as number),
    );

    const claimOf = (r: (typeof rows)[number]): HealthBenefitClaimRef => ({
      allowanceId: r.id,
      claimantId: r.claimant_id,
      voucherId: r.voucher_id,
      periodStart: r.period_start,
      exemptAmount: r.tax_free_amount,
      taxableAmount: r.taxable_amount,
      incomeTax: r.fringe_income_tax_amount,
      socialTax: r.fringe_social_tax_amount,
      exemptionBasis: r.exemption_basis,
    });

    const unresolvedHistoricalClaims: UnresolvedHistoricalClaim[] = [];
    const byMonth = new Map<
      string,
      {
        benefitValue: number;
        incomeTax: number;
        socialTax: number;
        claimants: Set<number>;
        claims: HealthBenefitClaimRef[];
      }
    >();
    let exemptTotal = 0;
    const exemptEmployees = new Set<number>();
    const exemptClaims: HealthBenefitClaimRef[] = [];

    for (const row of rows) {
      const claim = claimOf(row);

      // A posted claim with no recorded basis was classified by the code this
      // issue replaced — the one that exempted any amount. Its figures are in
      // the books and stay there; what changes is that the report says so.
      if (row.exemption_basis === null) {
        unresolvedHistoricalClaims.push({
          ...claim,
          reason:
            'Posted before the exemption limit was accounted for: no ' +
            'exemption basis or limit window was recorded, so the exempt ' +
            'amount was never measured against the annual cap.',
        });
      } else if (
        row.voucher_id !== null &&
        reversedVoucherIds.has(row.voucher_id)
      ) {
        unresolvedHistoricalClaims.push({
          ...claim,
          reason:
            "This claim's voucher has been reversed, in whole or in part. " +
            'The figures below still include it, because a reversal chain ' +
            'does not by itself establish that the benefit was economically ' +
            'undone; decide what the declaration should say before filing.',
        });
      } else if (
        row.taxable_amount > 0 &&
        row.fringe_income_tax_amount === 0 &&
        row.fringe_social_tax_amount === 0
      ) {
        unresolvedHistoricalClaims.push({
          ...claim,
          reason:
            'A taxable benefit with no employer fringe-benefit tax recorded ' +
            'against it, so the declaration line cannot be derived from it.',
        });
      }

      if (row.tax_free_amount > 0) {
        exemptTotal += row.tax_free_amount;
        exemptEmployees.add(row.claimant_id);
        exemptClaims.push(claim);
      }
      if (row.taxable_amount <= 0) continue;

      const month = row.period_start.slice(0, 7);
      const bucket = byMonth.get(month) ?? {
        benefitValue: 0,
        incomeTax: 0,
        socialTax: 0,
        claimants: new Set<number>(),
        claims: [],
      };
      bucket.benefitValue += row.taxable_amount;
      bucket.incomeTax += row.fringe_income_tax_amount;
      bucket.socialTax += row.fringe_social_tax_amount;
      bucket.claimants.add(row.claimant_id);
      bucket.claims.push(claim);
      byMonth.set(month, bucket);
    }

    const months: HealthBenefitMonth[] = [...byMonth.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, b]) => {
        // The declaration is computed on the month's TOTAL benefit — the form's
        // own arithmetic — which is not always the sum of per-claim roundings.
        const declared = plugin.resolveFringeBenefitTax(
          b.benefitValue,
          `${month}-01`,
          orgContext,
        );
        const declarationTax: FringeTaxPair = {
          incomeTax: declared?.incomeTax ?? b.incomeTax,
          socialTax: declared?.socialTax ?? b.socialTax,
        };
        return {
          month,
          benefitValue: b.benefitValue,
          ledgerTax: { incomeTax: b.incomeTax, socialTax: b.socialTax },
          declarationTax,
          roundingAdjustment: {
            incomeTax: declarationTax.incomeTax - b.incomeTax,
            socialTax: declarationTax.socialTax - b.socialTax,
          },
          claimants: b.claimants.size,
          dueDate: tsdDueDate(month),
          claims: b.claims,
        };
      });

    const divergentMonths = months.filter(
      (m) =>
        m.roundingAdjustment.incomeTax !== 0 ||
        m.roundingAdjustment.socialTax !== 0,
    );
    const readyToFile =
      unresolvedHistoricalClaims.length === 0 && divergentMonths.length === 0;

    const filingNotes = [
      `Taxable health and sports benefits are declared on TSD annex 4 under ` +
        `benefit code ${HEALTH_BENEFIT_CODE}, with the income and social tax ` +
        `borne by the employer, by the 10th day of the following month.`,
      'Tax-exempt health and sports expenditure is reported on INF 14 part ' +
        'III — the total and the number of employees it was paid for — by ' +
        '1 February of the following year.',
      'These are the figures to file, computed from posted claims. This ' +
        'endpoint submits nothing and produces no EMTA upload file; the ' +
        'declaration itself is filed in e-MTA.',
    ];

    if (unresolvedHistoricalClaims.length > 0) {
      filingNotes.push(
        `${unresolvedHistoricalClaims.length} posted claim(s) predate the ` +
          `exemption accounting and are listed under ` +
          `unresolvedHistoricalClaims. Their amounts are included in the ` +
          `totals because they are in the books, but they were classified ` +
          `before the annual cap was applied and may overstate the exempt ` +
          `total. Review each one before filing. Note the limitation: v1 has ` +
          `no correction or reversal path for a POSTED allowance (unlike an ` +
          `expense or a sales invoice), so a claim found to be wrong cannot be ` +
          `corrected through this API — it needs an accountant-entered ` +
          `adjusting voucher. Nothing in the posted ledger is rewritten here.`,
      );
    }
    if (divergentMonths.length > 0) {
      filingNotes.push(
        `In ${divergentMonths.map((m) => m.month).join(', ')} the tax posted ` +
          `per claim and the tax the declaration computes on the month's ` +
          `total differ by rounding (see roundingAdjustment). File the ` +
          `declaration figure and book the difference as an adjustment, or ` +
          `reconcile the two before filing — do not file one and pay the other.`,
      );
    }

    return {
      year,
      tsdAnnex4: { benefitCode: HEALTH_BENEFIT_CODE, months },
      inf14PartIii: {
        exemptTotal,
        employees: exemptEmployees.size,
        dueDate: `${year + 1}-02-01`,
        claims: exemptClaims,
      },
      unresolvedHistoricalClaims,
      readyToFile,
      filingNotes,
    };
  }
}

/** TSD for month M is due on the 10th of M+1. */
function tsdDueDate(month: string): string {
  const year = Number(month.slice(0, 4));
  const monthNo = Number(month.slice(5, 7));
  const next = new Date(Date.UTC(year, monthNo, 10));
  return next.toISOString().slice(0, 10);
}
