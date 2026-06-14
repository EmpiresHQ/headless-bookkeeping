import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** The lifecycle events that can be recorded against a period (ADR-0037). */
export const EVENT_KINDS = [
  'prepared',
  'submitted',
  'accepted',
  'rejected',
  'correction_submitted',
  'correction_accepted',
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

/** Operator-recordable kinds — `prepared` is system-emitted at lock only. */
export const RECORDABLE_EVENT_KINDS = [
  'submitted',
  'accepted',
  'rejected',
  'correction_submitted',
  'correction_accepted',
] as const;

/** The derived filing status (a fold output, never stored). */
export type SubmissionStatus =
  | 'not_started'
  | 'prepared'
  | 'submitted'
  | 'accepted'
  | 'rejected'
  | 'correction_submitted'
  | 'correction_accepted';

/** A persisted event, as returned in history. */
export interface SubmissionEvent {
  id: number;
  reporting_period_id: number;
  report_kind: string;
  source_snapshot_type: string;
  source_snapshot_id: number;
  event_kind: EventKind;
  external_ref: string | null;
  occurred_at: number;
  actor: string;
  note: string | null;
}

/** Folded filing state + full ordered history for a period. */
export interface SubmissionState {
  status: SubmissionStatus;
  currentSnapshotId: number | null;
  lastExternalRef: string | null;
  submissionCount: number;
  history: SubmissionEvent[];
}

export const recordSubmissionEventSchema = z.object({
  event_kind: z.enum(RECORDABLE_EVENT_KINDS),
  external_ref: z.string().optional(),
  note: z.string().optional(),
});

export class RecordSubmissionEventDto extends createZodDto(
  recordSubmissionEventSchema,
) {}
