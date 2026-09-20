import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely, sql } from 'kysely';
import { Database } from '../database/types';

/** One (currency, rate, source) population of posted lines. */
export interface FxProvenanceGroup {
  currency: string;
  fx_rate: number;
  /** NULL for a line posted before provenance existed (issue #203). */
  fx_rate_source: string | null;
  line_count: number;
  voucher_count: number;
  first_tax_point_date: string;
  last_tax_point_date: string;
  /** Sum of the base-currency amounts booked at this rate, in minor units. */
  base_amount_total: number;
}

export interface FxProvenanceAudit {
  /** Every non-identity population, largest first. */
  groups: FxProvenanceGroup[];
  /** Posted foreign-currency lines carrying no provenance at all. */
  unattributed_line_count: number;
  unattributed_voucher_count: number;
  /**
   * The subset that a single rate repeated across many dates makes suspicious:
   * one (currency, rate) applied on more than one distinct tax-point date,
   * with no provenance to justify it. A genuine reference rate moves.
   */
  suspected_date_blind: FxProvenanceGroup[];
}

/**
 * FxProvenanceAuditService — a READ-ONLY assessment of what the books were
 * actually booked at (issue #203 acceptance: "assess existing foreign-currency
 * vouchers").
 *
 * It answers the question the defect makes urgent — which posted lines carry a
 * rate nobody can trace — and it answers it WITHOUT touching a single voucher.
 * That restraint is the design, not a limitation: a posted voucher is
 * immutable (ADR-0019) and there is no break-glass (ADR-0012). A rate found to
 * be wrong is corrected the way every other posting error is corrected — by a
 * reversal plus a re-posting, through the corrections flow — never by
 * rewriting history, and never by back-filling a source onto a line that never
 * had one.
 *
 * Equally, a line whose rate is NOT the suspected placeholder is not thereby
 * declared correct. It is only "not in the placeholder population". This
 * service classifies evidence; a human decides.
 */
@Injectable()
export class FxProvenanceAuditService {
  constructor(@InjectKysely() private readonly db: Kysely<Database>) {}

  /**
   * Group every POSTED, non-base-rate voucher line by the rate it was booked
   * at and the provenance it carries.
   *
   * Only posted vouchers count: a draft has not entered the books. Lines at
   * `fx_rate = 1` are excluded — they are the base-currency legs, where no
   * conversion happened and there is nothing to attribute.
   */
  async assess(): Promise<FxProvenanceAudit> {
    const rows = await this.db
      .selectFrom('voucher_line')
      .innerJoin('voucher', 'voucher.id', 'voucher_line.voucher_id')
      .where('voucher.posted_at', 'is not', null)
      .where('voucher_line.fx_rate', '!=', 1)
      .select([
        'voucher_line.currency as currency',
        'voucher_line.fx_rate as fx_rate',
        'voucher_line.fx_rate_source as fx_rate_source',
        sql<number>`COUNT(*)`.as('line_count'),
        sql<number>`COUNT(DISTINCT voucher.id)`.as('voucher_count'),
        sql<number>`COUNT(DISTINCT voucher.tax_point_date)`.as('date_count'),
        sql<string>`MIN(voucher.tax_point_date)`.as('first_tax_point_date'),
        sql<string>`MAX(voucher.tax_point_date)`.as('last_tax_point_date'),
        sql<number>`SUM(voucher_line.base_amount)`.as('base_amount_total'),
      ])
      .groupBy([
        'voucher_line.currency',
        'voucher_line.fx_rate',
        'voucher_line.fx_rate_source',
      ])
      .orderBy(sql`COUNT(*)`, 'desc')
      .execute();

    const groups: FxProvenanceGroup[] = rows.map((r) => ({
      currency: r.currency,
      fx_rate: r.fx_rate,
      fx_rate_source: r.fx_rate_source,
      line_count: Number(r.line_count),
      voucher_count: Number(r.voucher_count),
      first_tax_point_date: r.first_tax_point_date,
      last_tax_point_date: r.last_tax_point_date,
      base_amount_total: Number(r.base_amount_total),
    }));

    const unattributed = rows.filter((r) => r.fx_rate_source === null);

    return {
      groups,
      unattributed_line_count: unattributed.reduce(
        (n, r) => n + Number(r.line_count),
        0,
      ),
      // Distinct vouchers cannot simply be summed across groups (one voucher
      // may carry two unattributed rates), so this is the honest upper bound
      // per group rather than a claimed exact total across them.
      unattributed_voucher_count: unattributed.reduce(
        (n, r) => n + Number(r.voucher_count),
        0,
      ),
      suspected_date_blind: groups.filter(
        (g, i) => g.fx_rate_source === null && Number(rows[i].date_count) > 1,
      ),
    };
  }
}
