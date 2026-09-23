import {
  nextRouteAfter,
  queuePosition,
  useInboxQueue,
  type InboxSegment,
} from '../queries/inbox';
import { pathOf, useCompletionNavigation } from '../lib/returnNavigation';

const SEGMENTS: readonly InboxSegment[] = ['all', 'triage', 'approvals'];

function segOf(href: string): InboxSegment {
  const p = new URLSearchParams(href.split('?')[1] ?? '');
  const raw = p.get('seg') ?? p.get('tab');
  return SEGMENTS.includes(raw as InboxSegment) ? (raw as InboxSegment) : 'all';
}

/** Where an Inbox item goes once decided (issue #252). Opened from the
 *  Inbox: the next item of THAT segment (a triage-only session never jumps
 *  into approvals), replacing the decided one; the last one returns to the
 *  Inbox entry it came from. Opened from elsewhere (Books' "Resolve in
 *  Inbox"): straight back there — no tour of an unrelated queue. Deep link:
 *  the whole queue, then /inbox. */
export function useInboxCompletion(route: string) {
  const nav = useCompletionNavigation();
  const originPath = nav.origin ? pathOf(nav.origin.href) : null;
  const fromInbox = originPath === '/inbox';
  const seg = fromInbox && nav.origin ? segOf(nav.origin.href) : 'all';
  const { entries } = useInboxQueue(seg);
  const position = queuePosition(entries, route);
  // Computed from the CURRENT queue before a mutation lands (the refetch
  // will drop the decided entry) — callers capture it when they start.
  const next = nextRouteAfter(entries, route);

  /** `gone`: the decision destroyed the object a cross-section origin
   *  shows — `path` is that origin's pathname, `to` its valid context. */
  const leave = (to: string, gone?: { path: string; to: string }) => {
    if (originPath !== null && !fromInbox) {
      nav.returnTo({
        fallback: '/inbox',
        originGone: gone && gone.path === originPath ? gone.to : undefined,
      });
    } else if (to !== '/inbox') {
      nav.advance(to);
    } else {
      nav.returnTo({ fallback: '/inbox', acceptOrigin: (p) => p === '/inbox' });
    }
  };

  return { entries, position, next, leave };
}
