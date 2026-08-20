import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely, sql } from 'kysely';
import { Database } from '../database/types';
import { ReportingPeriodsService } from '../reporting-periods/reporting-periods.service';
import {
  DuplicateExpenseRow,
  DuplicateMatchKind,
  findDuplicateExpense,
} from '../expenses/duplicate-detection';

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
   * List the duplicate groups that already exist in the books (issue #195),
   * using the SAME deterministic key the creation guard applies —
   * `(supplier_id, normalised invoice number)`, falling back to
   * `(supplier_id, currency, gross_amount, tax_point_date, claimant_id)` only
   * when the later of the two rows carries no number at all.
   *
   * The guard prevents NEW duplicates; this is the read side for the ones that
   * got in before it existed. Strictly read-only: it SELECTs, groups in memory
   * and returns — it never writes, reverses or resolves anything, because
   * deciding which of two expenses is the real one is a human judgement.
   *
   * Grouping walks the rows in ascending id order and asks the key whether each
   * row duplicates one already placed, so a group is always named by (and
   * anchored on) the ORIGINAL expense.
   */
  async getDuplicateCandidates(): Promise<
    Array<{
      supplier_id: number;
      matched_on: DuplicateMatchKind;
      expense_ids: number[];
      expenses: DuplicateExpenseRow[];
    }>
  > {
    const rows = await this.db
      .selectFrom('expense')
      .select([
        'id',
        'supplier_id',
        'supplier_invoice_number',
        'currency',
        'gross_amount',
        'tax_point_date',
        'status',
        'claimant_id',
        'ai_document_type',
      ])
      // A reversal exists precisely so the document can be re-entered, so a
      // reversed row is not a duplicate of anything.
      .where('status', '!=', 'reversed')
      .where('supplier_id', 'is not', null)
      .orderBy('id')
      .execute();

    const groups: Array<{
      supplier_id: number;
      matched_on: DuplicateMatchKind;
      expense_ids: number[];
      expenses: DuplicateExpenseRow[];
    }> = [];
    // Which group (by index) each already-placed expense belongs to.
    const groupOfExpense = new Map<number, number>();
    const placed: DuplicateExpenseRow[] = [];

    for (const row of rows) {
      const detection = findDuplicateExpense(row, placed);
      if (detection) {
        const index = groupOfExpense.get(detection.existingExpenseId);
        if (index !== undefined) {
          groups[index].expense_ids.push(row.id);
          groups[index].expenses.push(row);
          groupOfExpense.set(row.id, index);
        } else {
          const anchor = placed.find(
            (p) => p.id === detection.existingExpenseId,
          );
          groups.push({
            supplier_id: row.supplier_id as number,
            matched_on: detection.matchedOn,
            expense_ids: anchor ? [anchor.id, row.id] : [row.id],
            expenses: anchor ? [anchor, row] : [row],
          });
          const created = groups.length - 1;
          if (anchor) groupOfExpense.set(anchor.id, created);
          groupOfExpense.set(row.id, created);
        }
      }
      placed.push(row);
    }

    return groups;
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
