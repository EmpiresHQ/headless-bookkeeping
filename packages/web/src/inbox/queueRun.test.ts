import { describe, expect, it } from 'vitest';
import type { Approval, NeedsTriageItem } from '../api';
import { buildQueue, nextRouteAfter, queuePosition } from '../queries/inbox';
import {
  readRun,
  runEntries,
  runState,
  runWithout,
  segmentHref,
  type QueueRun,
} from './queueRun';

const DOC = (id: number, created_at: number) =>
  ({
    id,
    filename: `doc_${id}.pdf`,
    created_at,
    reason: 'x',
    reason_type: 'low_confidence',
  }) as NeedsTriageItem;

const APPR = (id: number, created_at: number) =>
  ({ id, object_type: 'expense', created_at }) as Approval;

const state = (run: unknown) => ({ hbkRun: run });

describe('readRun — untrusted history state', () => {
  it('reads a valid run (a copy of the members)', () => {
    const members = ['/inbox/doc/12', '/inbox/approval/7'];
    const run = readRun(state({ seg: 'all', members }));
    expect(run).toEqual({ seg: 'all', members });
    expect(run?.members).not.toBe(members);
  });

  it.each([
    ['no state', null],
    ['legacy state without a run', { hbkOrigin: { href: '/inbox' } }],
    ['run not an object', state('x')],
    ['unknown segment', state({ seg: 'bank', members: [] })],
    ['members not an array', state({ seg: 'all', members: '/inbox/doc/1' })],
    ['non-string member', state({ seg: 'all', members: [12] })],
    ['foreign route', state({ seg: 'all', members: ['/books/documents/1'] })],
    ['zero id', state({ seg: 'all', members: ['/inbox/doc/0'] })],
    ['padded id', state({ seg: 'all', members: ['/inbox/doc/012'] })],
    ['non-numeric id', state({ seg: 'all', members: ['/inbox/doc/1a'] })],
    [
      'duplicate member',
      state({ seg: 'all', members: ['/inbox/doc/1', '/inbox/doc/1'] }),
    ],
    [
      'approval in a triage run',
      state({ seg: 'triage', members: ['/inbox/doc/1', '/inbox/approval/2'] }),
    ],
    [
      'document in an approvals run',
      state({ seg: 'approvals', members: ['/inbox/doc/1'] }),
    ],
  ])('rejects %s', (_, s) => {
    expect(readRun(s)).toBeNull();
  });

  it('round-trips what the Inbox writes, uncapped', () => {
    const triage = Array.from({ length: 1200 }, (_, i) => DOC(i + 1, i));
    const entries = buildQueue(triage, [], 'triage');
    const run = readRun(runState('triage', entries));
    expect(run?.members).toHaveLength(1200);
    // The last (oldest) row is still a member — no silent single mode.
    expect(run?.members.includes('/inbox/doc/1')).toBe(true);
  });
});

describe('runEntries — live queue ∩ members, in SNAPSHOT order', () => {
  const run: QueueRun = {
    seg: 'all',
    members: ['/inbox/doc/12', '/inbox/approval/7', '/inbox/doc/13'],
  };

  it('ignores tasks that arrived after the snapshot', () => {
    const live = buildQueue(
      [DOC(12, 100), DOC(13, 300), DOC(99, 900)],
      [APPR(7, 200), APPR(98, 800)],
      'all',
    );
    const members = runEntries(live, run);
    expect(members.map((e) => e.route)).toEqual(run.members);
    expect(queuePosition(members, '/inbox/doc/12')).toEqual({
      pos: 1,
      total: 3,
    });
    expect(nextRouteAfter(members, '/inbox/doc/12')).toBe('/inbox/approval/7');
  });

  it('a live reorder does not change the next action', () => {
    // The server now sorts 13 before 7 before 12 — the run keeps its order.
    const live = buildQueue(
      [DOC(12, 100), DOC(13, 900)],
      [APPR(7, 500)],
      'all',
    );
    expect(live.map((e) => e.route)).toEqual([
      '/inbox/doc/13',
      '/inbox/approval/7',
      '/inbox/doc/12',
    ]);
    const members = runEntries(live, run);
    expect(nextRouteAfter(members, '/inbox/doc/12')).toBe('/inbox/approval/7');
  });

  it('members handled elsewhere drop out (no stale navigation)', () => {
    const live = buildQueue([DOC(12, 100)], [], 'all');
    const members = runEntries(live, run);
    expect(members.map((e) => e.route)).toEqual(['/inbox/doc/12']);
    expect(nextRouteAfter(members, '/inbox/doc/12')).toBe('/inbox');
  });

  it('a decided member is not revived when it comes back into the queue', () => {
    const after = readRun(runWithout(run, '/inbox/doc/12'));
    expect(after?.members).toEqual(['/inbox/approval/7', '/inbox/doc/13']);
    const live = buildQueue(
      [DOC(12, 100), DOC(13, 300)],
      [APPR(7, 200)],
      'all',
    );
    expect(runEntries(live, after!).map((e) => e.route)).not.toContain(
      '/inbox/doc/12',
    );
  });
});

describe('segmentHref', () => {
  it('maps a run segment to its Inbox list', () => {
    expect(segmentHref('all')).toBe('/inbox');
    expect(segmentHref('triage')).toBe('/inbox?seg=triage');
    expect(segmentHref('approvals')).toBe('/inbox?seg=approvals');
  });
});
