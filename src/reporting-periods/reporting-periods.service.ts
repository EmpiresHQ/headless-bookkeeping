import {
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely } from 'kysely';
import { Database } from '../database/types';
import { VatReportService } from '../vat-report/vat-report.service';
import {
  ReportingPeriod,
  CreateReportingPeriodDto,
  PeriodWarning,
} from './types';

@Injectable()
export class ReportingPeriodsService {
  constructor(
    @InjectKysely() private readonly db: Kysely<Database>,
    private readonly vatReportService: VatReportService,
  ) {}

  async list(): Promise<ReportingPeriod[]> {
    const rows = await this.db
      .selectFrom('reporting_period')
      .selectAll()
      .orderBy('start_date', 'asc')
      .execute();

    return rows.map((r) => this.mapRow(r));
  }

  async getById(id: number): Promise<ReportingPeriod> {
    const row = await this.db
      .selectFrom('reporting_period')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();

    if (!row) {
      throw new NotFoundException(`Reporting period ${id} not found`);
    }

    return this.mapRow(row);
  }

  /**
   * Delete a reporting period — ONLY if it is empty (open, never filed, with no
   * vouchers tax-point-dated inside it). Lets an operator undo a mistakenly
   * created period (there is no other removal path). A `locked` period or one
   * that already has vouchers is never deletable — those are corrected via the
   * normal reversal/correction flows.
   */
  async deleteEmptyPeriod(id: number): Promise<ReportingPeriod> {
    const period = await this.getById(id); // 404s if unknown

    if (period.status === 'locked') {
      throw new ConflictException(
        `Reporting period ${id} (${period.name}) is locked — cannot delete a filed period.`,
      );
    }

    const voucher = await this.db
      .selectFrom('voucher')
      .select('id')
      .where('tax_point_date', '>=', period.start_date)
      .where('tax_point_date', '<=', period.end_date)
      .limit(1)
      .executeTakeFirst();
    if (voucher) {
      throw new ConflictException(
        `Reporting period ${id} (${period.name}) has vouchers — only an empty period can be deleted.`,
      );
    }

    await this.db.deleteFrom('reporting_period').where('id', '=', id).execute();

    return period;
  }

  async getCurrent(): Promise<ReportingPeriod> {
    const row = await this.db
      .selectFrom('reporting_period')
      .selectAll()
      .where('status', '=', 'open')
      .orderBy('start_date', 'desc')
      .executeTakeFirst();

    if (!row) {
      throw new NotFoundException('No open reporting period found');
    }

    return this.mapRow(row);
  }

  async create(dto: CreateReportingPeriodDto): Promise<ReportingPeriod> {
    const now = Math.floor(Date.now() / 1000);

    // Reject a period that overlaps any existing one (D3). Two periods overlap
    // when each starts on or before the other ends; ISO date strings compare
    // lexicographically. Overlapping periods make `getCurrent` ambiguous and
    // let a single tax_point_date fall into two periods (double-counted in VAT
    // reports), so a date must belong to at most one reporting period.
    const overlap = await this.db
      .selectFrom('reporting_period')
      .select(['id', 'name'])
      .where('start_date', '<=', dto.end_date)
      .where('end_date', '>=', dto.start_date)
      .executeTakeFirst();
    if (overlap) {
      throw new ConflictException(
        `Reporting period ${dto.start_date}..${dto.end_date} overlaps existing period "${overlap.name}" (${overlap.id})`,
      );
    }

    const row = await this.db
      .insertInto('reporting_period')
      .values({
        name: dto.name,
        start_date: dto.start_date,
        end_date: dto.end_date,
        status: 'open',
        created_at: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    return this.mapRow(row);
  }

  /**
   * File (lock) a reporting period. Filing is ONE atomic act (ADR-0009): it
   * generates the immutable VAT-report snapshot AND flips the period to
   * `locked` (setting `filed_at` + `vat_report_snapshot_id`) in a single
   * transaction — both or neither. There is no "locked without snapshot" state.
   *
   * Idempotent: re-filing an already-locked period returns it unchanged and
   * never regenerates the snapshot. Filing must proceed in order: an earlier
   * still-open period blocks filing a later one (409).
   */
  async lock(id: number): Promise<ReportingPeriod> {
    const existing = await this.getById(id);

    // Idempotent: already locked → return as-is (no regeneration).
    if (existing.status === 'locked') {
      return existing;
    }

    // Filing order: no filing a later period while an earlier one is still open.
    const earlierOpen = await this.db
      .selectFrom('reporting_period')
      .select(['id', 'name'])
      .where('status', '=', 'open')
      .where('start_date', '<', existing.start_date)
      .orderBy('start_date', 'asc')
      .executeTakeFirst();

    if (earlierOpen) {
      throw new ConflictException(
        `Cannot file period ${existing.name}: earlier period ${earlierOpen.name} is still open — file it first`,
      );
    }

    const filedAt = Math.floor(Date.now() / 1000);

    const row = await this.db.transaction().execute(async (trx) => {
      // 1. Generate the immutable VAT snapshot inside the filing transaction.
      const snapshot = await this.vatReportService.generate(id, trx);

      // 2. Lock the period and bind it to the snapshot, atomically.
      return trx
        .updateTable('reporting_period')
        .set({
          status: 'locked',
          filed_at: filedAt,
          vat_report_snapshot_id: snapshot.id,
        })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();
    });

    return this.mapRow(row);
  }

  /**
   * List unresolved items that should be reviewed before locking a period:
   * - Pending approvals (expense/sales_invoice with status='pending' whose
   *   tax_point_date falls within the period)
   * - Unposted drafts (expense/sales_invoice with status='draft' whose
   *   tax_point_date falls within the period)
   *
   * Returns warnings but does NOT block locking — user decides.
   */
  async getWarnings(id: number): Promise<PeriodWarning[]> {
    const period = await this.getById(id);
    const warnings: PeriodWarning[] = [];

    // Pending approvals — expenses
    const pendingExpenses = await this.db
      .selectFrom('expense')
      .select(['id', 'category', 'gross_amount', 'currency'])
      .where('status', '=', 'pending')
      .where('tax_point_date', '>=', period.start_date)
      .where('tax_point_date', '<=', period.end_date)
      .execute();

    for (const e of pendingExpenses) {
      warnings.push({
        type: 'pending_approval',
        object_type: 'expense',
        object_id: e.id,
        description: `Expense #${e.id} (${e.category}, ${e.currency} ${e.gross_amount}) awaiting approval`,
      });
    }

    // Pending approvals — sales invoices
    const pendingInvoices = await this.db
      .selectFrom('sales_invoice')
      .select(['id', 'invoice_number', 'gross_amount', 'currency'])
      .where('status', '=', 'pending')
      .where('tax_point_date', '>=', period.start_date)
      .where('tax_point_date', '<=', period.end_date)
      .execute();

    for (const inv of pendingInvoices) {
      warnings.push({
        type: 'pending_approval',
        object_type: 'sales_invoice',
        object_id: inv.id,
        description: `SalesInvoice #${inv.invoice_number} (${inv.currency} ${inv.gross_amount}) awaiting approval`,
      });
    }

    // Unposted drafts — expenses
    const draftExpenses = await this.db
      .selectFrom('expense')
      .select(['id', 'category', 'gross_amount', 'currency'])
      .where('status', '=', 'draft')
      .where('tax_point_date', '>=', period.start_date)
      .where('tax_point_date', '<=', period.end_date)
      .execute();

    for (const e of draftExpenses) {
      warnings.push({
        type: 'unposted_draft',
        object_type: 'expense',
        object_id: e.id,
        description: `Expense #${e.id} (${e.category}, ${e.currency} ${e.gross_amount}) still in draft`,
      });
    }

    // Unposted drafts — sales invoices
    const draftInvoices = await this.db
      .selectFrom('sales_invoice')
      .select(['id', 'invoice_number', 'gross_amount', 'currency'])
      .where('status', '=', 'draft')
      .where('tax_point_date', '>=', period.start_date)
      .where('tax_point_date', '<=', period.end_date)
      .execute();

    for (const inv of draftInvoices) {
      warnings.push({
        type: 'unposted_draft',
        object_type: 'sales_invoice',
        object_id: inv.id,
        description: `SalesInvoice #${inv.invoice_number} (${inv.currency} ${inv.gross_amount}) still in draft`,
      });
    }

    return warnings;
  }

  private mapRow(row: {
    id: number;
    name: string;
    start_date: string;
    end_date: string;
    status: string;
    filed_at: number | null;
    vat_report_snapshot_id: number | null;
    created_at: number;
  }): ReportingPeriod {
    return {
      id: row.id,
      name: row.name,
      start_date: row.start_date,
      end_date: row.end_date,
      status: row.status as ReportingPeriod['status'],
      filed_at: row.filed_at,
      vat_report_snapshot_id: row.vat_report_snapshot_id,
      created_at: row.created_at,
    };
  }
}
