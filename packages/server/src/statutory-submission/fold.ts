import { EventKind, SubmissionStatus } from './types';

/** Minimal event shape the fold needs — pure, jurisdiction-neutral. */
export interface FoldEvent {
  event_kind: EventKind;
  source_snapshot_id: number;
  occurred_at: number;
  external_ref: string | null;
}

export interface FoldedState {
  status: SubmissionStatus;
  currentSnapshotId: number | null;
  lastExternalRef: string | null;
  submissionCount: number;
}

/**
 * Derive a period's filing state by folding its events (ADR-0037). Pure: no
 * DB, no clock. Events are folded in occurred_at order; the derived status is
 * the kind of the latest event, the current snapshot is the most recent
 * submission's snapshot (or the prepared snapshot if none), and the last
 * external ref is the most recent non-null ref. A format rejection followed
 * by a resubmission against the same snapshot is reflected as `submitted`
 * with submissionCount incremented and the snapshot unchanged.
 */
export function foldSubmissionState(events: FoldEvent[]): FoldedState {
  if (events.length === 0) {
    return {
      status: 'not_started',
      currentSnapshotId: null,
      lastExternalRef: null,
      submissionCount: 0,
    };
  }

  const ordered = [...events].sort((a, b) => a.occurred_at - b.occurred_at);

  let status: SubmissionStatus = 'not_started';
  let currentSnapshotId: number | null = null;
  let lastExternalRef: string | null = null;
  let submissionCount = 0;

  for (const e of ordered) {
    status = e.event_kind;
    if (e.event_kind === 'prepared') {
      currentSnapshotId = e.source_snapshot_id;
    }
    if (
      e.event_kind === 'submitted' ||
      e.event_kind === 'correction_submitted'
    ) {
      currentSnapshotId = e.source_snapshot_id;
      submissionCount += 1;
    }
    if (e.external_ref !== null) {
      lastExternalRef = e.external_ref;
    }
  }

  return { status, currentSnapshotId, lastExternalRef, submissionCount };
}
