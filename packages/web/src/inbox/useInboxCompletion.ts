import { useLocation } from 'react-router-dom';
import { nextRouteAfter, queuePosition, useInboxQueue } from '../queries/inbox';
import { pathOf, useCompletionNavigation } from '../lib/returnNavigation';
import {
  readRun,
  runEntries,
  runWithout,
  segmentHref,
  segmentLabel,
} from './queueRun';

const SECTIONS: Record<string, string> = {
  books: 'Books',
  bank: 'Bank',
  reports: 'Reports',
  settings: 'Settings',
};

function sectionLabel(path: string): string {
  return SECTIONS[path.split('/')[1] ?? ''] ?? 'Inbox';
}

/** The processing context of an Inbox item (issue #253) and where it goes
 *  once decided — see queueRun.ts for the run model.
 *
 *  QUEUE RUN (opened from an Inbox list): position over the run; the next
 *  run member replaces the decided one (#252 advance); none left — or the
 *  run cannot be evaluated yet (a list it needs is loading/failed) — returns
 *  to the Inbox entry of the run's segment. Never another segment's item.
 *
 *  SINGLE ITEM (Books, deep link, no run): no count; a cross-section origin
 *  gets the task back (#252), otherwise the entry becomes /inbox. */
export function useInboxCompletion(route: string) {
  const nav = useCompletionNavigation();
  const location = useLocation();
  const originPath = nav.origin ? pathOf(nav.origin.href) : null;
  const fromInbox = originPath === '/inbox';
  const found = readRun(location.state);
  const run = found !== null && found.members.includes(route) ? found : null;

  const { entries, triageQ, approvalsQ } = useInboxQueue(run?.seg ?? 'all');
  const ready =
    run !== null &&
    (run.seg === 'approvals' || triageQ.data !== undefined) &&
    (run.seg === 'triage' || approvalsQ.data !== undefined);
  const members = ready ? runEntries(entries, run) : [];
  const position = ready ? queuePosition(members, route) : null;
  // Computed from the CURRENT queue before a mutation lands (the refetch
  // will drop the decided entry) — callers capture it when they start.
  // '/inbox' = no next item: leave the run.
  const next = position !== null ? nextRouteAfter(members, route) : '/inbox';

  const backHref = run !== null ? segmentHref(run.seg) : '/inbox';
  const context =
    run !== null
      ? next !== '/inbox'
        ? `${segmentLabel(run.seg)} queue · next item follows`
        : `${segmentLabel(run.seg)} queue · returns to ${segmentLabel(run.seg)}`
      : `Single item · returns to ${
          originPath !== null ? sectionLabel(originPath) : 'Inbox'
        }`;

  /** `gone`: the decision destroyed the object a cross-section origin
   *  shows — `path` is that origin's pathname, `to` its valid context. */
  const leave = (to: string, gone?: { path: string; to: string }) => {
    if (originPath !== null && !fromInbox) {
      nav.returnTo({
        fallback: '/inbox',
        originGone: gone && gone.path === originPath ? gone.to : undefined,
      });
    } else if (run !== null && to !== '/inbox') {
      nav.advance(to, runWithout(run, route));
    } else {
      nav.returnTo({ fallback: backHref, acceptOrigin: (p) => p === '/inbox' });
    }
  };

  return { position, next, leave, context, backHref };
}
