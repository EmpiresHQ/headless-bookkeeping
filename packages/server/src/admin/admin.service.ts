import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely, sql } from 'kysely';
import { Database } from '../database/types';
import { ReportingPeriodsService } from '../reporting-periods/reporting-periods.service';

@Injectable()
export class AdminService {
  constructor(
    @InjectKysely() private readonly db: Kysely<Database>,
    private readonly reportingPeriodsService: ReportingPeriodsService,
  ) {}

  /**
   * List all accounts with computed balance (sum of signed base_amount
   * from voucher_line — debits add, credits subtract).
   */
  async getAccountsWithBalances() {
    const rows = await this.db
      .selectFrom('account')
      .leftJoin('voucher_line', 'voucher_line.account_id', 'account.id')
      .selectAll('account')
      .select(
        sql<number>`COALESCE(SUM(CASE WHEN voucher_line.is_debit = 1 THEN voucher_line.base_amount ELSE -voucher_line.base_amount END), 0)`.as(
          'balance',
        ),
      )
      .groupBy('account.id')
      .orderBy('account.code')
      .execute();

    return rows;
  }

  /**
   * List vouchers with optional date range filter on tax_point_date.
   */
  async getVouchers(from?: string, to?: string) {
    let query = this.db.selectFrom('voucher').selectAll();

    if (from) {
      query = query.where('tax_point_date', '>=', from);
    }
    if (to) {
      query = query.where('tax_point_date', '<=', to);
    }

    return query.orderBy('id').execute();
  }

  /**
   * Get a single voucher by id, including its voucher lines.
   */
  async getVoucherWithLines(id: number) {
    const voucher = await this.db
      .selectFrom('voucher')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();

    if (!voucher) {
      return null;
    }

    const lines = await this.db
      .selectFrom('voucher_line')
      .selectAll()
      .where('voucher_id', '=', id)
      .orderBy('id')
      .execute();

    return { ...voucher, lines };
  }

  /**
   * List all reporting periods.
   */
  async getPeriods() {
    return this.db
      .selectFrom('reporting_period')
      .selectAll()
      .orderBy('start_date', 'asc')
      .execute();
  }

  /**
   * Lock a reporting period. Delegates to ReportingPeriodsService.
   */
  async lockPeriod(id: number) {
    return this.reportingPeriodsService.lock(id);
  }

  /**
   * List approvals, optionally filtered by status.
   */
  async getApprovals(status?: string) {
    let query = this.db.selectFrom('approval').selectAll();
    if (status) {
      query = query.where('status', '=', status);
    }
    return query.orderBy('created_at', 'desc').execute();
  }

  /**
   * List audit findings, optionally filtered by status.
   */
  async getFindings(status?: string) {
    let query = this.db.selectFrom('audit_finding').selectAll();
    if (status) {
      query = query.where('status', '=', status);
    }
    return query.orderBy('created_at', 'desc').execute();
  }

  /**
   * Health check with DB connectivity probe.
   */
  async getHealth(): Promise<{
    status: string;
    timestamp: string;
    db: boolean;
  }> {
    try {
      await sql`SELECT 1`.execute(this.db);
      return {
        status: 'ok',
        timestamp: new Date().toISOString(),
        db: true,
      };
    } catch {
      return {
        status: 'error',
        timestamp: new Date().toISOString(),
        db: false,
      };
    }
  }
}
