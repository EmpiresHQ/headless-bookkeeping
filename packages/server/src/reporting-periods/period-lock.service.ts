import { Injectable, BadRequestException } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely } from 'kysely';
import { Database } from '../database/types';

/**
 * A reporting period as far as the lock check is concerned. A subset of the
 * `reporting_period` row — enough to detect membership and to re-date a
 * correction into the current open period.
 */
export interface PeriodRef {
  id: number;
  name: string;
  start_date: string;
  end_date: string;
  /** Which timeline the period belongs to — `vat` or `annual` (issue #207). */
  kind: string;
}

/**
 * PeriodLockService — the single, canonical answer to "is this tax-point date
 * in a locked reporting period?" (ADR-0009).
 *
 * The locked-period hard rule (no posting into a filed period) is a legal
 * *process* rule, not an arithmetic invariant. It is enforced at the
 * PostingService write chokepoint (ADR-0019) and surfaced early by
 * RulesService.validateHardProcess — both delegate here so the rule lives in
 * exactly one place. The corrections/late-document redirect (ADR-0009) also
 * uses this service to detect a locked target and find the current open period.
 *
 * Every method takes an optional `executor` so callers inside a posting
 * transaction can pass the transaction handle (`trx`) and see uncommitted
 * period changes; reads outside a transaction pass nothing and use `this.db`.
 */
@Injectable()
export class PeriodLockService {
  constructor(@InjectKysely() private readonly db: Kysely<Database>) {}

  /**
   * The locked period that contains `taxPointDate`, or `undefined` if the date
   * is not inside any locked period.
   *
   * Considers BOTH timelines (issue #207): a filed VAT period and a closed
   * financial year both make their dates unpostable, so a closed year seals
   * every date in it even where the monthly scope is still open.
   */
  async findLockedPeriod(
    taxPointDate: string,
    executor: Kysely<Database> = this.db,
  ): Promise<PeriodRef | undefined> {
    return (
      executor
        .selectFrom('reporting_period')
        .select(['id', 'name', 'start_date', 'end_date', 'kind'])
        .where('status', '=', 'locked')
        .where('start_date', '<=', taxPointDate)
        .where('end_date', '>=', taxPointDate)
        // Both timelines lock (issue #207): a filed month and a CLOSED FINANCIAL
        // YEAR each forbid posting on the dates they cover. When both cover the
        // date, name the year — it is the stronger statement (the whole year is
        // shut, not just that month) and the more useful message. 'annual' sorts
        // before 'vat'.
        .orderBy('kind', 'asc')
        .executeTakeFirst()
    );
  }

  /**
   * May the YEAR-END ADJUSTMENT of financial year `financialYearId` be posted
   * with this tax-point date? (Issue #207 — see `annual-close.ts` for why this
   * route exists and why it is a capability rather than a heuristic.)
   *
   * This is the ONLY thing that ever relaxes the locked-period rule, and it
   * relaxes it for exactly one case: a LOCKED VAT period, whose declaration the
   * adjustment cannot touch (the caller has already checked the accounts and
   * the VAT metadata). Everything else still rejects:
   *  - an unknown year, a VAT period passed as a year, or a year that is
   *    already CLOSED — a closed year is immutable for every writer;
   *  - a date outside the declared year — the capability covers that year only;
   *  - a date inside a DIFFERENT, closed financial year.
   */
  async assertAnnualClosePostable(
    taxPointDate: string,
    financialYearId: number,
    executor: Kysely<Database> = this.db,
  ): Promise<void> {
    const year = await executor
      .selectFrom('reporting_period')
      .select(['id', 'name', 'start_date', 'end_date', 'kind', 'status'])
      .where('id', '=', financialYearId)
      .executeTakeFirst();

    if (!year || year.kind !== 'annual') {
      throw new BadRequestException(
        `Cannot post a year-end adjustment: ${financialYearId} is not a financial year`,
      );
    }
    if (year.status !== 'open') {
      throw new BadRequestException(
        `Cannot post a year-end adjustment: financial year ${year.name} is closed`,
      );
    }
    if (taxPointDate < year.start_date || taxPointDate > year.end_date) {
      throw new BadRequestException(
        `Cannot post a year-end adjustment dated ${taxPointDate}: outside financial year ` +
          `${year.name} (${year.start_date}..${year.end_date})`,
      );
    }

    const lockedAnnual = await executor
      .selectFrom('reporting_period')
      .select(['id', 'name'])
      .where('status', '=', 'locked')
      .where('kind', '=', 'annual')
      .where('start_date', '<=', taxPointDate)
      .where('end_date', '>=', taxPointDate)
      .executeTakeFirst();
    if (lockedAnnual) {
      throw new BadRequestException(
        `Cannot post into closed financial year ${lockedAnnual.name}`,
      );
    }
  }

  /**
   * Hard process rule: reject if `taxPointDate` falls within a locked period —
   * a filed VAT period or a closed financial year.
   */
  async assertPeriodOpen(
    taxPointDate: string,
    executor: Kysely<Database> = this.db,
  ): Promise<void> {
    const locked = await this.findLockedPeriod(taxPointDate, executor);
    if (locked) {
      throw new BadRequestException(
        locked.kind === 'annual'
          ? `Cannot post into closed financial year ${locked.name}`
          : `Cannot post into locked period ${locked.name}`,
      );
    }
  }

  /**
   * The current open VAT period: the latest `open` one by start_date that can
   * still receive a posting. Multiple periods may be open at once (an unfiled
   * Q1 alongside Q2); corrections and late documents redirect into the most
   * recent open one. Returns `undefined` if there is none.
   */
  async getCurrentOpenPeriod(
    executor: Kysely<Database> = this.db,
  ): Promise<PeriodRef | undefined> {
    const candidates = await executor
      .selectFrom('reporting_period')
      .select(['id', 'name', 'start_date', 'end_date', 'kind'])
      .where('status', '=', 'open')
      .where('kind', '=', 'vat')
      .orderBy('start_date', 'desc')
      .execute();

    // Skip any month that still sits inside a CLOSED FINANCIAL YEAR (issue
    // #207). Such a month is open as far as VAT filing goes, but nothing can be
    // posted into it any more, so redirecting a correction there would move the
    // correction from one wall straight into another. The redirect wants the
    // first month that can actually receive a posting.
    const closedYears = await executor
      .selectFrom('reporting_period')
      .select(['start_date', 'end_date'])
      .where('status', '=', 'locked')
      .where('kind', '=', 'annual')
      .execute();

    return candidates.find(
      (p) =>
        !closedYears.some(
          (y) => y.start_date <= p.end_date && y.end_date >= p.start_date,
        ),
    );
  }
}
