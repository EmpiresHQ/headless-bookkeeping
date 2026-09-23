import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from 'react';
import { useLocation, useNavigationType } from 'react-router-dom';
import { isSameSession, sessionStamp, type SessionStamp } from '../auth';

/**
 * List position across a detail visit (issue #283): open a row, come back
 * with header Back or browser Back, and the list is where it was — the
 * opened row at the same height on screen, and focused.
 *
 * - Scope: only lists that call this hook (Books segments), no global
 *   scroll effect. Nothing is written into history: the record lives in
 *   this module, is bounded (`MAX`) and dies with the page.
 * - Identity: the exact history entry the list was LEFT from — its index
 *   and react-router key (a query REPLACE, e.g. each search keystroke,
 *   re-keys the entry: the key taken is the last one, at leave time), plus
 *   its href and the signed-in session. A restore happens only on a POP
 *   arrival onto that same entry; a new entry with the same pathname
 *   (PUSH, a sidebar link, a reload) never inherits it, nor does another
 *   session. A record is used once.
 * - Anchor: the row the user opened (else the topmost visible row) and its
 *   offset in the viewport, so a changed row set or a resize (desktop
 *   columns vs mobile cards) still lands on the same row; the raw scroll
 *   offset is the fallback when that row is gone.
 * - Timing: once the list's rows are READY (the caller's data), before
 *   paint, and again whenever they become ready anew (Retry after a failed
 *   refetch); re-anchored on every later layout change (late names,
 *   markers, a resize) until the user shows scroll intent (wheel, touch,
 *   key, pointer — activating a recovery control excepted) or navigates,
 *   and never after that intent, including intent before the rows
 *   arrived.
 */

interface Anchor {
  href: string;
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

/** Rows this hook anchors to: the row links of the list. */
export const POSITION_ROW = 'data-position-row';

function historyIdx(): number | null {
  const idx: unknown = (window.history.state as { idx?: unknown } | null)?.idx;
  return typeof idx === 'number' ? idx : null;
}

function rowsOf(root: HTMLElement): HTMLAnchorElement[] {
  return [...root.querySelectorAll<HTMLAnchorElement>(`a[${POSITION_ROW}]`)];
}

/** The first row whose bottom is below the viewport top (binary search —
 *  rows are in document order). */
function topmostRow(root: HTMLElement): HTMLAnchorElement | null {
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

function findRow(root: HTMLElement, href: string): HTMLAnchorElement | null {
  return rowsOf(root).find((a) => a.getAttribute('href') === href) ?? null;
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
  // This entry, as of the last render (a query REPLACE re-keys it).
  const entry = useRef({
    idx: historyIdx(),
    key: location.key,
    href: location.pathname + location.search,
  });
  entry.current = {
    idx: historyIdx(),
    key: location.key,
    href: location.pathname + location.search,
  };
  const scrollY = useRef(window.scrollY);
  const opened = useRef<Anchor | null>(null);
  // The session this list was shown in — taken at mount, never at leave: a
  // sign-in change landing with the navigation must not hand this list's
  // position to the new session.
  const [stamp] = useState(sessionStamp);

  // What to restore: looked up once, at mount, from the arrival (pure —
  // StrictMode may call this twice); spent in the layout effect below.
  const [arrival] = useState<PositionRecord | null>(() => {
    const { idx, key, href } = entry.current;
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
  const arrivedAt = useRef(entry.current.idx);
  useLayoutEffect(() => {
    // Arrived at this index: every record for it is spent or stale.
    records = records.filter((r) => r.idx !== arrivedAt.current);
  }, []);
  const intent = useRef(false);

  // Scroll offset + the row being opened, tracked while on screen.
  useEffect(() => {
    const root = rootRef.current;
    const onScroll = () => {
      scrollY.current = window.scrollY;
    };
    // Capture: the row link's own click navigates in the same task. Only
    // a same-tab, unmodified primary click opens the row HERE (react-router
    // Link's own rule); a Ctrl/Meta/Shift/Alt or middle click leaves this
    // page where it is and records nothing.
    const onOpen = (e: MouseEvent) => {
      const a = (e.target as Element | null)?.closest?.(`a[${POSITION_ROW}]`);
      if (!(a instanceof HTMLAnchorElement) || !root?.contains(a)) return;
      if (
        e.button !== 0 ||
        e.metaKey ||
        e.ctrlKey ||
        e.shiftKey ||
        e.altKey ||
        (a.target !== '' && a.target !== '_self')
      )
        return;
      scrollY.current = window.scrollY;
      opened.current = {
        href: a.getAttribute('href') ?? '',
        top: a.getBoundingClientRect().top,
        opened: true,
        y: window.scrollY,
      };
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
    window.addEventListener('scroll', onScroll, { passive: true });
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
      window.removeEventListener('scroll', onScroll);
      root?.removeEventListener('click', onOpen, true);
      for (const t of intents)
        window.removeEventListener(t, onIntent, { capture: true });
    };
  }, [rootRef]);

  // Leaving THIS entry (another history index or pathname — not a segment
  // switch, query edit or discard remount): record where the list stands.
  // A layout cleanup: the rows are still in the document.
  useLayoutEffect(() => {
    const root = rootRef.current;
    return () => {
      const { idx, key, href } = entry.current;
      if (idx === null || !isSameSession(stamp)) return;
      if (
        historyIdx() === idx &&
        window.location.pathname === href.split('?')[0]
      )
        return;
      // An opened row counts only if the list has not moved since (a click
      // whose navigation was refused, then a scroll, is not this leave).
      let anchor =
        opened.current !== null &&
        Math.abs(opened.current.y - scrollY.current) < 1
          ? opened.current
          : null;
      if (anchor === null && root?.isConnected) {
        const row = topmostRow(root);
        const rect = row?.getBoundingClientRect();
        if (row && rect && rect.height > 0)
          anchor = {
            href: row.getAttribute('href') ?? '',
            top: rect.top,
            opened: false,
            y: scrollY.current,
          };
      }
      records = [
        ...records.filter((r) => r.idx !== idx),
        { stamp, idx, key, href, y: scrollY.current, anchor },
      ].slice(-MAX);
    };
  }, [rootRef, stamp]);

  // Any navigation on this screen (query edit, segment switch) ends a
  // pending or settling restore.
  const arrivalKey = useRef(location.key);
  const moved = location.key !== arrivalKey.current;

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
      const row =
        record.anchor !== null ? findRow(root, record.anchor.href) : null;
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
      } else {
        window.scrollTo(0, record.y);
      }
      return row;
    };
    const row = place();
    // The opened row regains focus — without a second scroll — unless the
    // user already put focus somewhere (a Retry that unmounted with the
    // error leaves it on the body: the row takes it back).
    const active = document.activeElement;
    if (
      row !== null &&
      record.anchor?.opened &&
      (active === null || active === document.body)
    )
      row.focus({ preventScroll: true });
    // Late layout (names or markers arriving, fonts, a resize) re-anchors
    // for as long as the user has not acted: no settle timeout — a slow
    // lookup must not push the row off screen. Ends with intent, a
    // navigation (`moved` re-runs this effect) or unmount.
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (intent.current) {
        observer.disconnect();
        return;
      }
      place();
    });
    observer.observe(root);
    return () => observer.disconnect();
  }, [arrival, ready, moved, rootRef]);
}
