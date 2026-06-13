import { Inject, Injectable } from '@nestjs/common';
import { Kysely } from 'kysely';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import { Database } from '../database/types';
import { AuditLogService } from '../audit-log/audit-log.service';
import { foldSubmissionState } from './fold';
import {
  EventKind,
  SubmissionEvent,
  SubmissionState,
} from './types';

/** Everything needed to append one lifecycle event. */
export interface RecordEventInput {
  event_kind: EventKind;
  report_kind: string;
  source_snapshot_type: string;
  source_snapshot_id: number;
  actor: string;
  external_ref?: string | null;
  note?: string | null;
}

@Injectable()
export class StatutorySubmissionService {
  constructor(
    @Inject(KYSELY_MODULE_CONNECTION_TOKEN())
    private readonly db: Kysely<Database>,
    private readonly auditLog: AuditLogService,
  ) {}

  private now(): number {
    return Math.floor(Date.now() / 1000);
  }

  /**
   * Append one lifecycle event (ADR-0037) AND write an operational audit-log
   * entry (ADR-0026). Append-only: this never touches `reporting_period` or
   * `vat_report` — a `rejected` event therefore leaves the period locked and
   * the snapshot untouched (no-unlock invariant). v1 is operator-attested; no
   * e-MTA API is called.
   */
  async recordEvent(
    reportingPeriodId: number,
    input: RecordEventInput,
  ): Promise<SubmissionEvent> {
    const occurredAt = this.now();
    const externalRef = input.external_ref ?? null;
    const note = input.note ?? null;

    const row = await this.db
      .insertInto('statutory_submission_event')
      .values({
        reporting_period_id: reportingPeriodId,
        report_kind: input.report_kind,
        source_snapshot_type: input.source_snapshot_type,
        source_snapshot_id: input.source_snapshot_id,
        event_kind: input.event_kind,
        external_ref: externalRef,
        occurred_at: occurredAt,
        actor: input.actor,
        note,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await this.auditLog.record({
      actor: input.actor,
      action: `statutory_submission.event.${input.event_kind}`,
      outcome: 'recorded',
      target_type: 'reporting_period',
      target_id: reportingPeriodId,
      detail: {
        event_kind: input.event_kind,
        report_kind: input.report_kind,
        source_snapshot_type: input.source_snapshot_type,
        source_snapshot_id: input.source_snapshot_id,
        external_ref: externalRef,
      },
    });

    return this.mapRow(row);
  }

  /** Folded filing state + full ordered history for a period. */
  async getState(reportingPeriodId: number): Promise<SubmissionState> {
    const rows = await this.db
      .selectFrom('statutory_submission_event')
      .selectAll()
      .where('reporting_period_id', '=', reportingPeriodId)
      .orderBy('occurred_at', 'asc')
      .orderBy('id', 'asc')
      .execute();

    const history = rows.map((r) => this.mapRow(r));
    const folded = foldSubmissionState(
      history.map((h) => ({
        event_kind: h.event_kind,
        source_snapshot_id: h.source_snapshot_id,
        occurred_at: h.occurred_at,
        external_ref: h.external_ref,
      })),
    );

    return {
      status: folded.status,
      currentSnapshotId: folded.currentSnapshotId,
      lastExternalRef: folded.lastExternalRef,
      submissionCount: folded.submissionCount,
      history,
    };
  }

  private mapRow(row: {
    id: number;
    reporting_period_id: number;
    report_kind: string;
    source_snapshot_type: string;
    source_snapshot_id: number;
    event_kind: string;
    external_ref: string | null;
    occurred_at: number;
    actor: string;
    note: string | null;
  }): SubmissionEvent {
    return {
      id: row.id,
      reporting_period_id: row.reporting_period_id,
      report_kind: row.report_kind,
      source_snapshot_type: row.source_snapshot_type,
      source_snapshot_id: row.source_snapshot_id,
      event_kind: row.event_kind as EventKind,
      external_ref: row.external_ref,
      occurred_at: row.occurred_at,
      actor: row.actor,
      note: row.note,
    };
  }
}
