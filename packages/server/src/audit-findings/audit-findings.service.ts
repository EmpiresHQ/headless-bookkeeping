import { Injectable, Logger } from '@nestjs/common';
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
import {
  TriageReasonType,
  isTriageReasonType,
  TRIAGE_REASON_TYPES,
} from '../triage/types';

@Injectable()
export class AuditFindingsService {
  private readonly logger = new Logger(AuditFindingsService.name);
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

  private assertReasonType(reasonType: TriageReasonType | undefined): void {
    if (reasonType !== undefined && !isTriageReasonType(reasonType)) {
      throw new Error(
        `Invalid reason_type "${reasonType as string}". Must be one of: ${TRIAGE_REASON_TYPES.join(', ')}`,
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
    this.assertReasonType(dto.reason_type);

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
        reason_type: dto.reason_type ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    return this.mapRow(result);
  }

  /**
   * List AuditFindings, optionally filtered by severity.
   */
  async list(severity?: FindingSeverity): Promise<AuditFinding[]> {
    // Preserve the pre-#407 normalization at this public seam: an EMPTY
    // severity string (GET /api/audit-findings?severity=) previously fell
    // through `if (severity)` as unfiltered history — it must not start
    // throwing after the shared-reader refactor. Non-empty invalid values
    // still fail validation unchanged.
    return this.selectOrphanMarked({ severity: severity || undefined });
  }

  /**
   * List AuditFindings, optionally filtered by status (the admin history
   * surface, issue #407): every status stays visible — document-referenced
   * legacy orphans included — but explicitly marked
   * (`referenced_object_missing: true`) so they cannot masquerade as
   * actionable items.
   */
  async listByStatus(status?: FindingStatus): Promise<AuditFinding[]> {
    return this.selectOrphanMarked({ status });
  }

  /**
   * The shared orphan-aware read behind `list`/`listByStatus`: optional
   * severity/status filters, newest first, then document-reference existence
   * marking via {@link markDocumentOrphans}.
   */
  private async selectOrphanMarked(
    filter: { severity?: FindingSeverity; status?: FindingStatus } = {},
  ): Promise<AuditFinding[]> {
    if (filter.severity !== undefined) this.assertSeverity(filter.severity);
    if (filter.status !== undefined) this.assertStatus(filter.status);

    let query = this.db.selectFrom('audit_finding').selectAll();
    if (filter.severity !== undefined) {
      query = query.where('severity', '=', filter.severity);
    }
    if (filter.status !== undefined) {
      query = query.where('status', '=', filter.status);
    }

    const rows = await query
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .execute();

    // History surface: a legacy orphan stays VISIBLE for admin review, but
    // explicitly marked so it cannot masquerade as an actionable item (issue
    // #407).
    return this.markDocumentOrphans(
      rows.map((row: Record<string, unknown>) => this.mapRow(row)),
    );
  }

  private assertStatus(status: FindingStatus): void {
    if (!FINDING_STATUSES.includes(status)) {
      throw new Error(
        `Invalid status "${status}". Must be one of: ${FINDING_STATUSES.join(', ')}`,
      );
    }
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
   * Resolve a finding if it is still live (open or snoozed); a NO-OP when it
   * is already resolved. The guarded-idempotent form of `resolve()`: used
   * where a competing writer may have resolved the same finding
   * concurrently — e.g. the document-deletion lifecycle racing the intake
   * routing compensation (issue #407) — so the compensation neither masks the
   * original failure with `InvalidFindingTransitionError` nor overwrites
   * the competing writer's transition audit. A guarded UPDATE (rows updated
   * = 0 means terminal already) rather than read-then-transition, so the
   * check and the write are one atomic statement.
   */
  async resolveIfLive(
    id: number,
    ctx: TransitionContext = {},
  ): Promise<AuditFinding> {
    const now = Math.floor(Date.now() / 1000);
    const result = await this.db
      .updateTable('audit_finding')
      .set({
        status: 'resolved',
        resolved_at: now,
        transitioned_by: ctx.by ?? null,
        transition_reason: ctx.reason ?? null,
      })
      .where('id', '=', id)
      .where('status', 'in', ['open', 'snoozed'])
      .returningAll()
      .executeTakeFirst();
    if (result) {
      return this.mapRow(result);
    }
    // Zero rows updated: the finding is terminal (resolved) — nothing to
    // do, and the existing transition audit must be preserved. Read the row
    // back so the caller still gets the finding; unknown ids still throw.
    const current = await this.db
      .selectFrom('audit_finding')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow(
        () => new Error(`AuditFinding with id ${id} not found`),
      );
    return this.mapRow(current);
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
   * Find a single open finding of a given type that references a specific
   * business object. This is the deterministic idempotency guard the intake
   * workflow uses before creating a `needs_triage` finding: a retry of a
   * Document that already routed to a human must reuse the existing finding
   * rather than double-create one.
   *
   * Returns the most-recent matching open finding, or undefined if none.
   */
  async findOpenByReference(
    findingType: FindingType,
    referencedObjectType: ReferencedObjectType,
    referencedObjectId: number,
  ): Promise<AuditFinding | undefined> {
    this.assertFindingType(findingType);
    this.assertReferencedObjectType(referencedObjectType);

    const row = await this.db
      .selectFrom('audit_finding')
      .selectAll()
      .where('finding_type', '=', findingType)
      .where('referenced_object_type', '=', referencedObjectType)
      .where('referenced_object_id', '=', referencedObjectId)
      .where('status', '=', 'open')
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .executeTakeFirst();

    return row ? this.mapRow(row) : undefined;
  }

  /**
   * Update the description AND reason_type of an open finding. Used when a
   * document is re-routed to needs_triage after a retry — the old
   * description (and its stale reason_type) would otherwise show the
   * ORIGINAL failure reason to the operator even though the re-run may have
   * failed for a different reason (e.g. an OCR failure retried into a
   * Pass-2 failure must flip ocr_failed -> classification_failed, not just
   * the free text).
   */
  async updateTriageReason(
    id: number,
    description: string,
    reasonType: TriageReasonType,
  ): Promise<void> {
    await this.db
      .updateTable('audit_finding')
      .set({ description, reason_type: reasonType })
      .where('id', '=', id)
      .where('status', '=', 'open')
      .execute();
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

    const flagged = await this.markDocumentOrphans(
      rows.map((row: Record<string, unknown>) => this.mapRow(row)),
    );

    // Work-queue surface: a finding whose document is missing is a dead link
    // — the queue must not offer it as actionable. New deletes resolve
    // findings atomically (DocumentsService.deleteDocument, issue #407), so
    // anything filtered here is a LEGACY orphan; keep it visible (warn) for
    // admin review via list().
    const orphans = flagged.filter((f) => f.referenced_object_missing);
    if (orphans.length > 0) {
      this.logger.warn(
        `getOpenFindings: excluding ${orphans.length} legacy orphan finding(s) whose document is missing ` +
          `(ids: ${orphans.map((f) => f.id).join(', ')}) — resolve them via the findings list`,
      );
    }
    return flagged.filter((f) => !f.referenced_object_missing);
  }

  /**
   * Mark document-referenced findings whose document row is missing (legacy
   * orphans, issue #407): `referenced_object_missing: true`. Non-document
   * references are marked `false` — existence is not assessed for other object
   * types here (follow-up if a deletion path for them ever orphans findings).
   */
  private async markDocumentOrphans(
    findings: AuditFinding[],
  ): Promise<AuditFinding[]> {
    const existingIds = await this.existingDocumentIds(findings);
    return findings.map((f) =>
      f.referenced_object_type === 'document' &&
      f.referenced_object_id !== null &&
      !existingIds.has(f.referenced_object_id)
        ? { ...f, referenced_object_missing: true }
        : { ...f, referenced_object_missing: false },
    );
  }

  /** The set of document ids that exist among `findings`' document references. */
  private async existingDocumentIds(
    findings: AuditFinding[],
  ): Promise<Set<number>> {
    const docIds = [
      ...new Set(
        findings
          .filter(
            (f) =>
              f.referenced_object_type === 'document' &&
              f.referenced_object_id !== null,
          )
          .map((f) => f.referenced_object_id as number),
      ),
    ];
    if (docIds.length === 0) return new Set();
    const rows = await this.db
      .selectFrom('document')
      .select('id')
      .where('id', 'in', docIds)
      .execute();
    return new Set(rows.map((r) => r.id));
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
      reason_type: (row.reason_type as TriageReasonType) ?? null,
    };
  }
}
