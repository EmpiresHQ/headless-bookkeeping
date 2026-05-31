import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely } from 'kysely';
import { Database } from '../database/types';
import { ReportingPeriod, CreateReportingPeriodDto } from './types';

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
