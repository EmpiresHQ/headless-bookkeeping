import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import {
  useLocation,
  useNavigationType,
  type Location,
} from 'react-router-dom';
import { isSameSession, sessionStamp, type SessionStamp } from '../auth';

/**
 * List position across a detail visit (issue #283): open a row, come back
 * with header Back or browser Back, and the list is where it was — the
 * opened row at the same height on screen, and focused.
 *
 * - Scope: only lists that call this hook (Books segments, the Inbox, a
 *   bank statement — issue #355), no global scroll effect. Nothing is
 *   written into history: the record lives in this module, is bounded
 *   (`MAX`) and dies with the page.
 * - Identity: the exact history entry the list was LEFT from — its index
 *   and react-router key (a query REPLACE, e.g. each search keystroke,
 *   re-keys the entry: the key taken is the last one, at leave time), plus
 *   its href and the signed-in session. A restore happens only on a POP
 *   arrival onto that same entry; a new entry with the same pathname
 *   (PUSH, a sidebar link, a reload) never inherits it, nor does another
 *   session. A record is spent on arrival; leaving the returned list
 *   records it again (the same row, while the list has not moved), so
 *   every Back → Forward → Back lands there again.
 * - Leave time: a history traversal (browser Back/Forward, header Back)
 *   snapshots the list at its `popstate` — the browser then restores the
 *   TARGET entry's offset while this list is still mounted (the route
 *   renders later, in a transition), so the offset at unmount is not the
 *   list's. A PUSH scrolls nothing: the list is read at unmount.
 * - Anchor: the row the user opened (else the topmost visible row) and its
 *   offset in the viewport, so a changed row set or a resize (desktop
 *   columns vs mobile cards) still lands on the same row. A row is a link
 *   or a navigation button marked `POSITION_ROW` (its value, else its
 *   href, identifies it); a row of the same `POSITION_GROUP` stands in
 *   when that exact one is gone, else the raw scroll offset is the
 *   fallback.
 * - Timing: once the list's rows are READY (the caller's data), before
 *   paint, and again whenever they become ready anew (Retry after a failed
 *   refetch); re-anchored on every later layout or row-set change (late
 *   names, markers, a resize, a refetch swapping rows) until the user
 *   shows scroll intent (wheel, touch, key, pointer — activating a
 *   recovery control excepted) or navigates, and never after that intent,
 *   including intent before the rows arrived.
 */

interface Anchor {
  /** The row's identity (`POSITION_ROW`'s value, else its href). */
  id: string;
  /** Its group (`POSITION_GROUP`): any row of it stands in when this exact
   *  row is gone. */
  group: string | null;
  top: number;
  /** The user opened this row (focus goes back to it). */
  opened: boolean;
  /** Page offset when the anchor was taken. */
  y: number;
}

interface PositionRecord {
  stamp: SessionStamp;
  idx: number;
  key: string;
  href: string;
  y: number;
  anchor: Anchor | null;
}

const MAX = 20;
let records: PositionRecord[] = [];

/** Marks a recovery control (e.g. LoadError's Retry): pressing it keeps a
 *  pending return position armed instead of counting as user intent. */
export const KEEPS_POSITION = 'data-keeps-position';

/** Rows this hook anchors to: the list's navigation controls — row links,
 *  or buttons that navigate (never a selection or action control). An empty
 *  value identifies a link by its href; a button names itself. */
export const POSITION_ROW = 'data-position-row';

/** Optional: the item a row belongs to (e.g. a bank line with several
 *  proposal rows) — a return lands on a sibling when the exact row is
 *  gone. */
export const POSITION_GROUP = 'data-position-group';

function historyIdx(): number | null {
  const idx: unknown = (window.history.state as { idx?: unknown } | null)?.idx;
  return typeof idx === 'number' ? idx : null;
}

/** The entry history stands on: react-router's key in its state (the
 *  first entry has none — react-router calls it "default"). */
function entryKey(): string {
  const key: unknown = (window.history.state as { key?: unknown } | null)?.key;
  return typeof key === 'string' ? key : 'default';
}

interface Entry {
  idx: number | null;
  key: string;
  href: string;
}

/** A location's history entry. Its index is read only while history
 *  stands on it — a render after a popstate already sees the next entry. */
function entryOf(location: Location): Entry {
  return {
    idx: entryKey() === location.key ? historyIdx() : null,
    key: location.key,
    href: location.pathname + location.search,
  };
}

function rowsOf(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(`[${POSITION_ROW}]`)];
}

function rowId(row: Element): string {
  return row.getAttribute(POSITION_ROW) || (row.getAttribute('href') ?? '');
}

function anchorOf(row: HTMLElement, opened: boolean): Anchor {
  return {
    id: rowId(row),
    group: row.getAttribute(POSITION_GROUP),
    top: row.getBoundingClientRect().top,
    opened,
    y: window.scrollY,
  };
}

/** The first row whose bottom is below the viewport top (binary search —
 *  rows are in document order). */
function topmostRow(root: HTMLElement): HTMLElement | null {
  const rows = rowsOf(root);
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].getBoundingClientRect().bottom <= 0) lo = mid + 1;
    else hi = mid;
  }
  return rows[lo] ?? null;
}

/** The anchor's own row, else (it is gone) the first row of its group. */
function findRow(root: HTMLElement, anchor: Anchor): HTMLElement | null {
  const rows = rowsOf(root);
  return (
    rows.find((r) => rowId(r) === anchor.id) ??
    (anchor.group === null
      ? undefined
      : rows.find((r) => r.getAttribute(POSITION_GROUP) === anchor.group)) ??
    null
  );
}

/** The on-screen band a restored row must sit in: below the top edge and
 *  ABOVE the phone tab bar (fixed, `data-tabbar`; zero height on desktop,
 *  where it is hidden) — so a desktop → mobile return never parks the row
 *  under the bar. */
const MARGIN = 8;
function clampTop(top: number, height: number): number {
  const bar = document.querySelector('[data-tabbar]');
  const barTop = bar?.getBoundingClientRect().height
    ? bar.getBoundingClientRect().top
    : window.innerHeight;
  const max = barTop - height - MARGIN;
  return Math.max(MARGIN, Math.min(top, max));
}

/** Test seam: forget every record. */
export function resetListPositions() {
  records = [];
}

export function useReturnPosition(
  rootRef: RefObject<HTMLElement>,
  ready: boolean,
) {
  const location = useLocation();
  const navigationType = useNavigationType();
  // This entry, as committed (a query REPLACE re-keys it) — updated after
  // commit, never during render: a discarded or late render must not
  // re-point it, and history may already stand on the next entry.
  const [initial] = useState(() => entryOf(location));
  const entry = useRef(initial);
  useLayoutEffect(() => {
    if (entry.current.key === location.key) return;
    entry.current = entryOf(location);
  }, [location]);
  const opened = useRef<Anchor | null>(null);
  // The session this list was shown in — taken at mount, never at leave: a
  // sign-in change landing with the navigation must not hand this list's
  // position to the new session.
  const [stamp] = useState(sessionStamp);

  // What to restore: looked up once, at mount, from the arrival (pure —
  // StrictMode may call this twice); spent in the layout effect below.
  const [arrival] = useState<PositionRecord | null>(() => {
    const { idx, key, href } = initial;
    if (navigationType !== 'POP' || idx === null) return null;
    return (
      records.find(
        (r) =>
          r.idx === idx &&
          r.key === key &&
          r.href === href &&
          isSameSession(r.stamp),
      ) ?? null
    );
  });
  useLayoutEffect(() => {
    // Arrived at this index: every record for it is spent or stale.
    records = records.filter((r) => r.idx !== initial.idx);
  }, [initial]);
  const intent = useRef(false);
  // The row this hook last focused on a return (maybe a group stand-in).
  const autoFocused = useRef<HTMLElement | null>(null);
  // The rows are shown (as last committed).
  const shown = useRef(ready);
  useLayoutEffect(() => {
    shown.current = ready;
  }, [ready]);

  // Where the list stands NOW, for the record its entry keeps when left.
  const snapshot = (): { y: number; anchor: Anchor | null } => {
    // A return still armed but without its rows (loading, or a failed
    // refetch awaiting Retry): the entry's position is still the one being
    // returned to, not the collapsed page.
    if (
      arrival !== null &&
      !shown.current &&
      !intent.current &&
      entry.current.key === initial.key
    )
      return { y: arrival.y, anchor: arrival.anchor };
    const root = rootRef.current;
    const y = window.scrollY;
    // An opened row counts only if the list has not moved since (a click
    // whose navigation was refused, then a scroll, is not this leave).
    if (opened.current !== null && Math.abs(opened.current.y - y) < 1)
      return { y, anchor: opened.current };
    const row = root?.isConnected ? topmostRow(root) : null;
    return {
      y,
      anchor:
        row && row.getBoundingClientRect().height > 0
          ? anchorOf(row, false)
          : null,
    };
  };
  // Taken when a history traversal leaves this entry. The browser restores
  // the TARGET entry's scroll offset right after `popstate` — before React
  // unmounts this list — so by cleanup time the page offset is no longer
  // the list's.
  const left = useRef<{ to: string; y: number; anchor: Anchor | null } | null>(
    null,
  );
  const snapshotRef = useRef(snapshot);
  useLayoutEffect(() => {
    snapshotRef.current = snapshot;
  });

  // The row being opened, and a traversal away, tracked while on screen.
  useLayoutEffect(() => {
    const root = rootRef.current;
    const onPop = () => {
      const to = entryKey();
      left.current =
        to === entry.current.key ? null : { to, ...snapshotRef.current() };
    };
    // Capture: the row's own click navigates in the same task. A row link
    // opens HERE only on a same-tab, unmodified primary click (react-router
    // Link's own rule); a Ctrl/Meta/Shift/Alt or middle click leaves this
    // page where it is and records nothing. A row button navigates on any
    // click (Enter and Space included), so any click opens it.
    const onOpen = (e: MouseEvent) => {
      const row = (e.target as Element | null)?.closest?.(`[${POSITION_ROW}]`);
      if (!(row instanceof HTMLElement) || !root?.contains(row)) return;
      if (
        row instanceof HTMLAnchorElement &&
        (e.button !== 0 ||
          e.metaKey ||
          e.ctrlKey ||
          e.shiftKey ||
          e.altKey ||
          (row.target !== '' && row.target !== '_self'))
      )
        return;
      opened.current = anchorOf(row, true);
    };
    // A recovery control (LoadError's Retry, `KEEPS_POSITION`) restores
    // what failed: ACTIVATING it (primary press, the start of a tap,
    // Enter/Space) is not intent to leave the returned position. Scrolling
    // is, wherever the pointer or focus is — a wheel, a touch drag
    // (touchmove) or any other key over Retry still disarms.
    const onIntent = (e: Event) => {
      const t = e.target;
      const recovery =
        t instanceof Element && t.closest(`[${KEEPS_POSITION}]`) !== null;
      if (recovery) {
        if (e.type === 'pointerdown' && (e as MouseEvent).button === 0) return;
        if (e.type === 'touchstart') return;
        if (e.type === 'keydown') {
          const key = (e as KeyboardEvent).key;
          if (key === 'Enter' || key === ' ') return;
        }
      }
      intent.current = true;
    };
    window.addEventListener('popstate', onPop);
    root?.addEventListener('click', onOpen, true);
    const intents = [
      'wheel',
      'touchstart',
      'touchmove',
      'keydown',
      'pointerdown',
    ];
    for (const t of intents)
      window.addEventListener(t, onIntent, { passive: true, capture: true });
    return () => {
      window.removeEventListener('popstate', onPop);
      root?.removeEventListener('click', onOpen, true);
      for (const t of intents)
        window.removeEventListener(t, onIntent, { capture: true });
    };
  }, [rootRef]);

  // Leaving THIS entry (another history index or pathname — not a segment
  // switch, query edit or discard remount): record where the list stands —
  // as taken at the traversal away, else (a PUSH, which scrolls nothing)
  // now. A layout cleanup: the rows are still in the document.
  useLayoutEffect(
    () => () => {
      const { idx, key, href } = entry.current;
      if (idx === null || !isSameSession(stamp)) return;
      if (
        historyIdx() === idx &&
        window.location.pathname === href.split('?')[0]
      )
        return;
      const at =
        left.current !== null && left.current.to === entryKey()
          ? left.current
          : snapshotRef.current();
      records = [
        ...records.filter((r) => r.idx !== idx),
        { stamp, idx, key, href, y: at.y, anchor: at.anchor },
      ].slice(-MAX);
    },
    [stamp],
  );

  // Any navigation on this screen (query edit, segment switch) ends a
  // pending or settling restore.
  const moved = location.key !== initial.key;

  // Placed each time the rows become READY while still armed: a stale
  // refetch that fails after the first placement replaces the rows with
  // LoadError (the page collapses to its top); its Retry — a recovery, not
  // scroll intent — brings them back and the list returns to the row
  // again. Real intent (wheel, touch, key, pointer outside a recovery
  // control) or any navigation disarms it for good.
  useLayoutEffect(() => {
    const record = arrival;
    const root = rootRef.current;
    if (!ready || record === null || root === null) return;
    if (intent.current || moved) return;
    const place = () => {
      const row = record.anchor !== null ? findRow(root, record.anchor) : null;
      if (row !== null && record.anchor !== null) {
        const rect = row.getBoundingClientRect();
        // The opened row must end up visible (a desktop → phone return may
        // grow it, the tab bar covers the bottom); a topmost-row anchor
        // returns exactly where it was.
        const top = record.anchor.opened
          ? clampTop(record.anchor.top, rect.height)
          : record.anchor.top;
        const delta = rect.top - top;
        window.scrollTo(0, window.scrollY + delta);
        // The returned row stays the opened one while the list rests
        // here: leaving again (Forward, then Back) returns to it again —
        // to the exact row the user opened, even while a group sibling
        // stands in for it.
        if (record.anchor.opened) {
          opened.current = {
            ...anchorOf(row, true),
            id: record.anchor.id,
            group: record.anchor.group,
          };
          // The opened row (or its stand-in) regains focus — without a
          // second scroll — unless the user already put focus somewhere. A
          // Retry that unmounted with the error leaves it on the body: the
          // row takes it back. A stand-in this hook focused hands it on to
          // the exact row once that shows up (whether or not the stand-in
          // is still in the list); focus the user moved stays put.
          const active = document.activeElement;
          if (
            active !== row &&
            (active === null ||
              active === document.body ||
              active === autoFocused.current)
          ) {
            row.focus({ preventScroll: true });
            autoFocused.current = row;
          }
        }
      } else {
        window.scrollTo(0, record.y);
      }
    };
    place();
    // Late layout (names or markers arriving, fonts, a resize) re-anchors
    // for as long as the user has not acted: no settle timeout — a slow
    // lookup must not push the row off screen. So does a changed row set
    // (a refetch swapping the opened control for a sibling of its group, or
    // bringing it back) even when the list keeps its height, which no
    // resize reports. Ends with intent, a navigation (`moved` re-runs this
    // effect) or unmount; paused while history already stands on another
    // entry (a traversal away whose screen is still loading: the browser
    // has restored THAT entry's offset, which is not to be fought).
    const observers: { disconnect(): void }[] = [];
    const disconnect = () => observers.forEach((o) => o.disconnect());
    const onChange = () => {
      if (intent.current) {
        disconnect();
        return;
      }
      if (entryKey() !== entry.current.key) return;
      place();
    };
    if (typeof ResizeObserver !== 'undefined') {
      const resized = new ResizeObserver(onChange);
      resized.observe(root);
      observers.push(resized);
    }
    if (typeof MutationObserver !== 'undefined') {
      const rowsChanged = new MutationObserver(onChange);
      // Rows added or removed, or a reused row node re-identified.
      rowsChanged.observe(root, {
        childList: true,
        subtree: true,
        attributeFilter: [POSITION_ROW],
      });
      observers.push(rowsChanged);
    }
    return disconnect;
  }, [arrival, ready, moved, rootRef]);
}
