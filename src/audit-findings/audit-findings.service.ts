import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely, sql } from 'kysely';
import { Database } from '../database/types';
import {
  AuditFinding,
  CreateAuditFindingDto,
  FindingSeverity,
  FindingStatus,
  FindingType,
  ReferencedObjectType,
  TransitionContext,
  InvalidFindingTransitionError,
  canTransition,
  FINDING_SEVERITIES,
  FINDING_TYPES,
  FINDING_STATUSES,
  REFERENCED_OBJECT_TYPES,
} from './types';

@Injectable()
export class AuditFindingsService {
  constructor(@InjectKysely() private readonly db: Kysely<Database>) {}

  // ── Validation guards ───────────────────────────────────────────

  private assertSeverity(severity: FindingSeverity): void {
    if (!FINDING_SEVERITIES.includes(severity)) {
      throw new Error(
        `Invalid severity "${severity}". Must be one of: ${FINDING_SEVERITIES.join(', ')}`,
      );
    }
  }

  private assertFindingType(findingType: FindingType): void {
    if (!FINDING_TYPES.includes(findingType)) {
      throw new Error(
        `Invalid finding_type "${findingType}". Must be one of: ${FINDING_TYPES.join(', ')}`,
      );
    }
  }

  private assertReferencedObjectType(
    refType: ReferencedObjectType | undefined,
  ): void {
    if (refType !== undefined && !REFERENCED_OBJECT_TYPES.includes(refType)) {
      throw new Error(
        `Invalid referenced_object_type "${refType}". Must be one of: ${REFERENCED_OBJECT_TYPES.join(', ')}`,
      );
    }
  }

  /**
   * Create a new AuditFinding. Validates the typed kind, reference type, and
   * severity up-front so an unknown value can never be persisted (and so an
   * unknown severity can never silently sort last in the ranked queue).
   */
  async create(dto: CreateAuditFindingDto): Promise<AuditFinding> {
    this.assertFindingType(dto.finding_type);
    this.assertSeverity(dto.severity);
    this.assertReferencedObjectType(dto.referenced_object_type);

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
        snoozed_at: null,
        transitioned_by: null,
        transition_reason: null,
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
      this.assertSeverity(severity);
      query = query.where('severity', '=', severity);
    }

    const rows = await query
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .execute();

    return rows.map((row: Record<string, unknown>) => this.mapRow(row));
  }

  /**
   * Mark a finding as resolved — a guarded `* -> resolved` transition.
   */
  async resolve(
    id: number,
    ctx: TransitionContext = {},
  ): Promise<AuditFinding> {
    const now = Math.floor(Date.now() / 1000);
    return this.transition(id, 'resolved', ctx, { resolved_at: now });
  }

  /**
   * Mark a finding as snoozed — a guarded `* -> snoozed` transition.
   */
  async snooze(id: number, ctx: TransitionContext = {}): Promise<AuditFinding> {
    const now = Math.floor(Date.now() / 1000);
    return this.transition(id, 'snoozed', ctx, { snoozed_at: now });
  }

  /**
   * Reopen a snoozed finding — a guarded `snoozed -> open` transition.
   */
  async reopen(id: number, ctx: TransitionContext = {}): Promise<AuditFinding> {
    return this.transition(id, 'open', ctx, { resolved_at: null });
  }

  /**
   * The single guarded write path for the lifecycle state machine. Reads the
   * current status, consults FINDING_TRANSITIONS, and rejects an illegal move
   * instead of doing a blind UPDATE. Records who/when/why on the row.
   */
  async transition(
    id: number,
    to: FindingStatus,
    ctx: TransitionContext = {},
    extra: {
      resolved_at?: number | null;
      snoozed_at?: number | null;
    } = {},
  ): Promise<AuditFinding> {
    if (!FINDING_STATUSES.includes(to)) {
      throw new Error(
        `Invalid target status "${to}". Must be one of: ${FINDING_STATUSES.join(', ')}`,
      );
    }

    const current = await this.db
      .selectFrom('audit_finding')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();

    if (!current) {
      throw new Error(`AuditFinding with id ${id} not found`);
    }

    const from = current.status as FindingStatus;
    if (!canTransition(from, to)) {
      throw new InvalidFindingTransitionError(from, to);
    }

    const result = await this.db
      .updateTable('audit_finding')
      .set({
        status: to,
        transitioned_by: ctx.by ?? null,
        transition_reason: ctx.reason ?? null,
        ...extra,
      })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();

    return this.mapRow(result);
  }

  /**
   * Get all open findings (used by SecretaryAgent), severity-ranked.
   */
  async getOpenFindings(): Promise<AuditFinding[]> {
    // severity is a TEXT column, so a plain `ORDER BY severity DESC` sorts
    // lexically (medium > low > high > critical) — wrong. Rank it explicitly so
    // the SecretaryAgent surfaces critical first. create() validates severity,
    // so the `ELSE 0` (unknown sorts last) branch is now unreachable for any
    // service-written row — it survives only as a defensive guard for legacy
    // or directly-inserted rows.
    const rows = await this.db
      .selectFrom('audit_finding')
      .selectAll()
      .where('status', '=', 'open')
      .orderBy(
        sql`CASE severity WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 WHEN 'low' THEN 1 ELSE 0 END`,
        'desc',
      )
      .orderBy('created_at', 'asc')
      .execute();

    return rows.map((row: Record<string, unknown>) => this.mapRow(row));
  }

  private mapRow(row: Record<string, unknown>): AuditFinding {
    return {
      id: row.id as number,
      finding_type: row.finding_type as FindingType,
      severity: row.severity as FindingSeverity,
      description: row.description as string,
      referenced_object_type:
        (row.referenced_object_type as ReferencedObjectType) ?? null,
      referenced_object_id: (row.referenced_object_id as number) ?? null,
      status: row.status as FindingStatus,
      created_at: row.created_at as number,
      resolved_at: (row.resolved_at as number) ?? null,
      snoozed_at: (row.snoozed_at as number) ?? null,
      transitioned_by: (row.transitioned_by as string) ?? null,
      transition_reason: (row.transition_reason as string) ?? null,
    };
  }
}
