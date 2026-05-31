import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely } from 'kysely';
import { Database } from '../database/types';
import {
  AuditFinding,
  CreateAuditFindingDto,
  FindingSeverity,
  FindingStatus,
} from './types';

const VALID_SEVERITIES: FindingSeverity[] = [
  'low',
  'medium',
  'high',
  'critical',
];
// VALID_STATUSES is reserved for future status validation
const _VALID_STATUSES: FindingStatus[] = ['open', 'resolved', 'snoozed'];

@Injectable()
export class AuditFindingsService {
  constructor(@InjectKysely() private readonly db: Kysely<Database>) {}

  /**
   * Create a new AuditFinding.
   */
  async create(dto: CreateAuditFindingDto): Promise<AuditFinding> {
    if (!VALID_SEVERITIES.includes(dto.severity)) {
      throw new Error(
        `Invalid severity "${dto.severity}". Must be one of: ${VALID_SEVERITIES.join(', ')}`,
      );
    }

    const now = Math.floor(Date.now() / 1000);
    const result = await this.db
      .insertInto('audit_finding')
      .values({
        finding_type: dto.finding_type,
        severity: dto.severity,
        description: dto.description,
        referenced_object_type: dto.referenced_object_type ?? null,
        referenced_object_id: dto.referenced_object_id ?? null,
        status: 'open',
        created_at: now,
        resolved_at: null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    return this.mapRow(result);
  }

  /**
   * List AuditFindings, optionally filtered by severity.
   */
  async list(severity?: FindingSeverity): Promise<AuditFinding[]> {
    let query = this.db.selectFrom('audit_finding').selectAll();

    if (severity) {
      if (!VALID_SEVERITIES.includes(severity)) {
        throw new Error(
          `Invalid severity "${severity}". Must be one of: ${VALID_SEVERITIES.join(', ')}`,
        );
      }
      query = query.where('severity', '=', severity);
    }

    const rows = await query
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .execute();

    return rows.map((row: Record<string, unknown>) => this.mapRow(row));
  }

  /**
   * Mark a finding as resolved.
   */
  async resolve(id: number): Promise<AuditFinding> {
    const now = Math.floor(Date.now() / 1000);
    const result = await this.db
      .updateTable('audit_finding')
      .set({ status: 'resolved', resolved_at: now })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();

    if (!result) {
      throw new Error(`AuditFinding with id ${id} not found`);
    }

    return this.mapRow(result);
  }

  /**
   * Mark a finding as snoozed.
   */
  async snooze(id: number): Promise<AuditFinding> {
    const result = await this.db
      .updateTable('audit_finding')
      .set({ status: 'snoozed' })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();

    if (!result) {
      throw new Error(`AuditFinding with id ${id} not found`);
    }

    return this.mapRow(result);
  }

  /**
   * Get all open findings (used by SecretaryAgent).
   */
  async getOpenFindings(): Promise<AuditFinding[]> {
    const rows = await this.db
      .selectFrom('audit_finding')
      .selectAll()
      .where('status', '=', 'open')
      .orderBy('severity', 'desc')
      .orderBy('created_at', 'asc')
      .execute();

    return rows.map((row: Record<string, unknown>) => this.mapRow(row));
  }

  private mapRow(row: Record<string, unknown>): AuditFinding {
    return {
      id: row.id as number,
      finding_type: row.finding_type as string,
      severity: row.severity as FindingSeverity,
      description: row.description as string,
      referenced_object_type: (row.referenced_object_type as string) ?? null,
      referenced_object_id: (row.referenced_object_id as number) ?? null,
      status: row.status as FindingStatus,
      created_at: row.created_at as number,
      resolved_at: (row.resolved_at as number) ?? null,
    };
  }
}
