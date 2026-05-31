import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely } from 'kysely';
import { Database } from '../database/types';
import {
  ReportingPeriod,
  CreateReportingPeriodDto,
  PeriodWarning,
} from './types';

@Injectable()
export class ReportingPeriodsService {
  constructor(@InjectKysely() private readonly db: Kysely<Database>) {}

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
   * Lock a reporting period (open → locked). Idempotent: re-locking an
   * already-locked period returns 200 with the existing locked period.
   */
  async lock(id: number): Promise<ReportingPeriod> {
    const existing = await this.getById(id);

    // Idempotent: already locked → return as-is
    if (existing.status === 'locked') {
      return existing;
    }

    const filedAt = Math.floor(Date.now() / 1000);
    const row = await this.db
      .updateTable('reporting_period')
      .set({ status: 'locked', filed_at: filedAt })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();

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
