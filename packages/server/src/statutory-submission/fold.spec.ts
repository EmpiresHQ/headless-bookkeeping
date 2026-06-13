import { foldSubmissionState, FoldEvent } from './fold';

const ev = (over: Partial<FoldEvent>): FoldEvent => ({
  event_kind: 'prepared',
  source_snapshot_id: 1,
  occurred_at: 1000,
  external_ref: null,
  ...over,
});

describe('foldSubmissionState', () => {
  it('returns not_started for no events', () => {
    const state = foldSubmissionState([]);
    expect(state.status).toBe('not_started');
    expect(state.currentSnapshotId).toBeNull();
    expect(state.lastExternalRef).toBeNull();
  });

  it('prepared only → prepared', () => {
    const state = foldSubmissionState([
      ev({ event_kind: 'prepared', source_snapshot_id: 7 }),
    ]);
    expect(state.status).toBe('prepared');
    expect(state.currentSnapshotId).toBe(7);
  });

  it('prepared → submitted → submitted (pins snapshot + ref)', () => {
    const state = foldSubmissionState([
      ev({ event_kind: 'prepared', source_snapshot_id: 7, occurred_at: 1000 }),
      ev({
        event_kind: 'submitted',
        source_snapshot_id: 7,
        occurred_at: 2000,
        external_ref: 'EMTA-1',
      }),
    ]);
    expect(state.status).toBe('submitted');
    expect(state.currentSnapshotId).toBe(7);
    expect(state.lastExternalRef).toBe('EMTA-1');
  });

  it('→ accepted', () => {
    const state = foldSubmissionState([
      ev({ event_kind: 'prepared', source_snapshot_id: 7, occurred_at: 1000 }),
      ev({ event_kind: 'submitted', source_snapshot_id: 7, occurred_at: 2000, external_ref: 'EMTA-1' }),
      ev({ event_kind: 'accepted', source_snapshot_id: 7, occurred_at: 3000, external_ref: 'EMTA-1' }),
    ]);
    expect(state.status).toBe('accepted');
    expect(state.currentSnapshotId).toBe(7);
  });

  it('→ rejected', () => {
    const state = foldSubmissionState([
      ev({ event_kind: 'prepared', source_snapshot_id: 7, occurred_at: 1000 }),
      ev({ event_kind: 'submitted', source_snapshot_id: 7, occurred_at: 2000, external_ref: 'EMTA-1' }),
      ev({ event_kind: 'rejected', source_snapshot_id: 7, occurred_at: 3000 }),
    ]);
    expect(state.status).toBe('rejected');
    expect(state.currentSnapshotId).toBe(7);
  });

  it('resubmission after a format rejection — two submitted, same snapshot', () => {
    const state = foldSubmissionState([
      ev({ event_kind: 'prepared', source_snapshot_id: 7, occurred_at: 1000 }),
      ev({ event_kind: 'submitted', source_snapshot_id: 7, occurred_at: 2000, external_ref: 'EMTA-1' }),
      ev({ event_kind: 'rejected', source_snapshot_id: 7, occurred_at: 3000 }),
      ev({ event_kind: 'submitted', source_snapshot_id: 7, occurred_at: 4000, external_ref: 'EMTA-2' }),
    ]);
    expect(state.status).toBe('submitted');
    // Resubmission is against the SAME frozen snapshot.
    expect(state.currentSnapshotId).toBe(7);
    expect(state.lastExternalRef).toBe('EMTA-2');
    expect(state.submissionCount).toBe(2);
  });

  it('correction events → correction_accepted', () => {
    const state = foldSubmissionState([
      ev({ event_kind: 'prepared', source_snapshot_id: 7, occurred_at: 1000 }),
      ev({ event_kind: 'submitted', source_snapshot_id: 7, occurred_at: 2000, external_ref: 'EMTA-1' }),
      ev({ event_kind: 'accepted', source_snapshot_id: 7, occurred_at: 3000, external_ref: 'EMTA-1' }),
      ev({ event_kind: 'correction_submitted', source_snapshot_id: 7, occurred_at: 4000, external_ref: 'EMTA-C1' }),
      ev({ event_kind: 'correction_accepted', source_snapshot_id: 7, occurred_at: 5000, external_ref: 'EMTA-C1' }),
    ]);
    expect(state.status).toBe('correction_accepted');
    expect(state.lastExternalRef).toBe('EMTA-C1');
  });

  it('folds in occurred_at order regardless of input order', () => {
    const state = foldSubmissionState([
      ev({ event_kind: 'accepted', source_snapshot_id: 7, occurred_at: 3000 }),
      ev({ event_kind: 'prepared', source_snapshot_id: 7, occurred_at: 1000 }),
      ev({ event_kind: 'submitted', source_snapshot_id: 7, occurred_at: 2000, external_ref: 'EMTA-1' }),
    ]);
    expect(state.status).toBe('accepted');
  });
});
