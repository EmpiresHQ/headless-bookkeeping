import type { InboxEntry, InboxSegment } from '../queries/inbox';

/**
 * Inbox processing contexts (issue #253). An item is processed either as a
 * SINGLE item (Books "Resolve in Inbox", deep link, anything without a run)
 * or as part of a QUEUE RUN — started only by opening an item from an Inbox
 * list. The run lives in that item's history state: the segment and the
 * members (routes) in the order the operator saw them when entering. It is
 * evaluated as the SNAPSHOT order restricted to members still in the live
 * queue: tasks that arrive meanwhile never join it, a refresh that reorders
 * the server list never changes the next action, entries handled elsewhere
 * drop out, and the members decided in this run are removed on advance
 * (never revived if they come back). Uncapped: a member is one short route.
 */
export interface QueueRun {
  seg: InboxSegment;
  members: string[];
}

const RUN = 'hbkRun';

const SEGMENTS: readonly InboxSegment[] = ['all', 'triage', 'approvals'];
const ROUTE: Record<InboxSegment, RegExp> = {
  all: /^\/inbox\/(doc|approval)\/[1-9]\d*$/,
  triage: /^\/inbox\/doc\/[1-9]\d*$/,
  approvals: /^\/inbox\/approval\/[1-9]\d*$/,
};

/** A run read back from history state (untrusted: legacy or malformed
 *  state is no run at all). Every member must be an item route of the
 *  run's own segment, listed once. */
export function readRun(state: unknown): QueueRun | null {
  if (typeof state !== 'object' || state === null) return null;
  const r = (state as Record<string, unknown>)[RUN];
  if (typeof r !== 'object' || r === null) return null;
  const { seg, members } = r as Record<string, unknown>;
  if (!SEGMENTS.includes(seg as InboxSegment)) return null;
  const route = ROUTE[seg as InboxSegment];
  if (
    !Array.isArray(members) ||
    !members.every((m) => typeof m === 'string' && route.test(m)) ||
    new Set(members).size !== members.length
  )
    return null;
  return { seg: seg as InboxSegment, members: [...(members as string[])] };
}

/** History state that starts a run over the segment's visible queue. */
export function runState(
  seg: InboxSegment,
  entries: InboxEntry[],
): { [RUN]: QueueRun } {
  return {
    [RUN]: {
      seg,
      members: entries.map((e) => e.route),
    },
  };
}

/** The run carried to the next item: the decided route is no longer a
 *  member. */
export function runWithout(run: QueueRun, route: string): { [RUN]: QueueRun } {
  return {
    [RUN]: { seg: run.seg, members: run.members.filter((m) => m !== route) },
  };
}

/** The run's members still in the live queue, in SNAPSHOT order (live
 *  data per entry). */
export function runEntries(entries: InboxEntry[], run: QueueRun): InboxEntry[] {
  const live = new Map(entries.map((e) => [e.route, e]));
  return run.members.flatMap((m) => live.get(m) ?? []);
}

/** The Inbox list a run belongs to (`all` is the bare /inbox). */
export function segmentHref(seg: InboxSegment): string {
  return seg === 'all' ? '/inbox' : `/inbox?seg=${seg}`;
}

export function segmentLabel(seg: InboxSegment): string {
  return seg === 'triage'
    ? 'Triage'
    : seg === 'approvals'
      ? 'Approvals'
      : 'Inbox';
}
