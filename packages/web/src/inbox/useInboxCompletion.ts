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

const BOOKS_RECORD = /^\/books\/(expenses|invoices)\/([1-9]\d*)$/;

/** A Books record an approval was opened from (issue #262): its typed pair
 *  and name — null for any other path. */
export function booksRecordOf(path: string): {
  objectType: 'expense' | 'sales_invoice';
  objectId: number;
  label: string;
} | null {
  const m = BOOKS_RECORD.exec(path);
  if (m === null) return null;
  const objectId = Number(m[2]);
  return m[1] === 'expenses'
    ? { objectType: 'expense', objectId, label: `Expense #${objectId}` }
    : { objectType: 'sales_invoice', objectId, label: `Invoice #${objectId}` };
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
 *  gets the task back (#252), otherwise the entry becomes /inbox. A Books
 *  record origin (`source`, #262) is also the fallback — with its own
 *  history state — so its operator never lands in the global queue. */
export function useInboxCompletion(route: string) {
  const nav = useCompletionNavigation();
  const location = useLocation();
  const originPath = nav.origin ? pathOf(nav.origin.href) : null;
  const fromInbox = originPath === '/inbox';
  const source =
    nav.origin !== null && originPath !== null
      ? (() => {
          const record = booksRecordOf(originPath);
          return record !== null
            ? { ...record, href: nav.origin.href, state: nav.origin.state }
            : null;
        })()
      : null;
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

  // A single item from an Inbox list goes back to that exact list (#278).
  const backHref =
    run !== null
      ? segmentHref(run.seg)
      : (source?.href ??
        (fromInbox && nav.origin !== null ? nav.origin.href : '/inbox'));
  const context =
    run !== null
      ? next !== '/inbox'
        ? `${segmentLabel(run.seg)} queue · next item follows`
        : `${segmentLabel(run.seg)} queue · returns to ${segmentLabel(run.seg)}`
      : `Single item · returns to ${
          source !== null
            ? source.label
            : originPath !== null
              ? sectionLabel(originPath)
              : 'Inbox'
        }`;

  /** `gone`: the decision destroyed the object a cross-section origin
   *  shows — `path` is that origin's pathname, `to` its valid context. */
  const leave = (to: string, gone?: { path: string; to: string }) => {
    if (originPath !== null && !fromInbox) {
      nav.returnTo({
        fallback: source?.href ?? '/inbox',
        fallbackState: source?.state,
        originGone: gone && gone.path === originPath ? gone.to : undefined,
      });
    } else if (run !== null && to !== '/inbox') {
      nav.advance(to, runWithout(run, route));
    } else if (run === null && fromInbox && nav.origin !== null) {
      // A single item opened from an Inbox list (a search hit, #278): even
      // without the #252 proof, land on that exact list — its ?q=/?seg= and
      // its own history state — never a bare /inbox.
      nav.returnTo({
        fallback: nav.origin.href,
        fallbackState: nav.origin.state,
        acceptOrigin: (p) => p === '/inbox',
      });
    } else {
      nav.returnTo({ fallback: backHref, acceptOrigin: (p) => p === '/inbox' });
    }
  };

  return {
    position,
    next,
    leave,
    context,
    backHref,
    source,
    advance: nav.advance,
  };
}
