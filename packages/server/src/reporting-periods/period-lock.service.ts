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
   */
  async findLockedPeriod(
    taxPointDate: string,
    executor: Kysely<Database> = this.db,
  ): Promise<PeriodRef | undefined> {
    return executor
      .selectFrom('reporting_period')
      .select(['id', 'name', 'start_date', 'end_date'])
      .where('status', '=', 'locked')
      .where('start_date', '<=', taxPointDate)
      .where('end_date', '>=', taxPointDate)
      .executeTakeFirst();
  }

  /**
   * Hard process rule: reject if `taxPointDate` falls within a locked period.
   */
  async assertPeriodOpen(
    taxPointDate: string,
    executor: Kysely<Database> = this.db,
  ): Promise<void> {
    const locked = await this.findLockedPeriod(taxPointDate, executor);
    if (locked) {
      throw new BadRequestException(
        `Cannot post into locked period ${locked.name}`,
      );
    }
  }

  /**
   * The current open period: the latest `open` period by start_date. Multiple
   * periods may be open at once (an unfiled Q1 alongside Q2); corrections
   * redirect into the most recent open one. Returns `undefined` if none is open.
   */
  async getCurrentOpenPeriod(
    executor: Kysely<Database> = this.db,
  ): Promise<PeriodRef | undefined> {
    return executor
      .selectFrom('reporting_period')
      .select(['id', 'name', 'start_date', 'end_date'])
      .where('status', '=', 'open')
      .orderBy('start_date', 'desc')
      .executeTakeFirst();
  }
}
