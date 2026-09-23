import { useLayoutEffect, useRef, useState } from 'react';
import { useLocation, useNavigationType } from 'react-router-dom';
import { isSameSession, sessionStamp, type SessionStamp } from '../auth';
import { isUsableFocusTarget } from './focusReturn';

/**
 * Where a detail screen starts (issue #357): a NEW entry — opened from a
 * list (PUSH) or reached by queue auto-next (REPLACE to another object) —
 * starts at its top with focus on its header title, never at the offset the
 * previous screen left behind.
 *
 * - Scope: only screens that call this hook (item details), no global
 *   scroll effect. Lists keep `useReturnPosition` (lib/listPosition).
 * - Arrival: the commit that shows THIS screen for a new pathname — the
 *   hook's own layout effect, so the outgoing screen (still shown while a
 *   lazy chunk loads) has already been unmounted and taken its own leave
 *   snapshot. A query-only change (sheet, filter) is not an arrival, nor is
 *   a remount on the same entry (route discard, sign-in shell, StrictMode).
 * - PUSH/REPLACE: scroll to the top at arrival; the title is focused once
 *   the screen has settled (`ready`: not its loading skeleton).
 * - POP (Back/Forward onto an entry this screen was left from in this page
 *   and session): back to that entry's own offset, once the page is tall
 *   enough; a POP without such a record starts at the top. Title focus as
 *   above. The page's first load (also a POP) is left to the browser.
 * - Never late: pending placement or focus ends at the user's first scroll,
 *   key or pointer intent, or when the entry is left. Focus moves only from
 *   nowhere (body) or from what the previous entry left focused — never out
 *   of an open dialog or away from what the user chose — and waits while a
 *   closing layer still hides the screen (aria-hidden/inert).
 */

/** The screen header's title (`ScreenHeader`): the focus target. */
export const SCREEN_TITLE = 'data-screen-title';

interface EntryRecord {
  stamp: SessionStamp;
  key: string;
  path: string;
  y: number;
}

const MAX = 20;
let records: EntryRecord[] = [];
/** The entry a hooked screen shows now (a remount on it is no arrival). */
let current: { key: string; path: string } | null = null;
/** The entry the last browser traversal landed on — a POP arrival without
 *  it is the page's own first load. */
let lastPopKey: string | null = null;

function entryKey(): string {
  const key: unknown = (window.history.state as { key?: unknown } | null)?.key;
  return typeof key === 'string' ? key : 'default';
}

if (typeof window !== 'undefined') {
  window.addEventListener(
    'popstate',
    () => {
      lastPopKey = entryKey();
    },
    true,
  );
}

/** Test seam: forget every record and the page's traversal state. */
export function resetScreenEntries() {
  records = [];
  current = null;
  lastPopKey = null;
}

function scrollTop() {
  if (window.scrollX !== 0 || window.scrollY !== 0) window.scrollTo(0, 0);
}

function maxScroll(): number {
  return document.documentElement.scrollHeight - window.innerHeight;
}

const LAYER = '[role="dialog"], [role="alertdialog"]';

/** The one screen title on the page, outside any dialog. */
function titleTarget(): HTMLElement | null {
  const titles = [
    ...document.querySelectorAll<HTMLElement>(`[${SCREEN_TITLE}]`),
  ].filter((el) => el.closest(LAYER) === null);
  return titles.length === 1 ? titles[0] : null;
}

interface Pending {
  focus: boolean;
  /** POP: the entry's own offset, until reached. */
  y: number | null;
  /** Focused when the entry arrived — the previous entry's control. */
  stale: Element | null;
}

export function useScreenEntry(ready: boolean) {
  const location = useLocation();
  const navigationType = useNavigationType();
  const [stamp] = useState(sessionStamp);
  // This entry's latest key (a query REPLACE re-keys it), after commit.
  const key = useRef(location.key);
  useLayoutEffect(() => {
    key.current = location.key;
    if (current !== null && current.path === location.pathname)
      current = { key: location.key, path: location.pathname };
    // A query change committed on this entry: resume what it paused.
    settle.current();
  }, [location.key, location.pathname]);
  const readyRef = useRef(ready);
  const pathRef = useRef(location.pathname);
  const pending = useRef<Pending | null>(null);
  const settle = useRef(() => {});
  settle.current = () => {
    const p = pending.current;
    if (p === null || !readyRef.current) return;
    // Only for the entry it belongs to, while history stands on it: a
    // traversal away whose screen is still loading (the browser has put
    // THAT entry's offset in place) or another sign-in pauses it.
    if (
      entryKey() !== key.current ||
      window.location.pathname !== pathRef.current ||
      !isSameSession(stamp)
    )
      return;
    if (p.y !== null) {
      window.scrollTo(0, p.y);
      if (maxScroll() >= p.y - 1) p.y = null;
    }
    if (p.focus) {
      const target = titleTarget();
      const active = document.activeElement;
      // In a layer (the outgoing one still closing, or open): wait — it
      // hands focus back to the body when it goes, or to its opener.
      const layered = active?.closest(LAYER) != null;
      const free =
        active === null ||
        active === document.body ||
        (active === p.stale && !layered);
      if (!free && !layered) p.focus = false;
      else if (free && isUsableFocusTarget(target)) {
        target.focus({ preventScroll: true });
        p.focus = false;
      }
    }
    if (!p.focus && p.y === null) pending.current = null;
  };

  // Where this entry stands now, for its record when left: a return still
  // placing (no user intent yet — the page not tall enough, clamped) keeps
  // the offset it is returning to, not the clamped one.
  const where = () => pending.current?.y ?? window.scrollY;
  // A traversal away, taken at its `popstate`: the browser then restores
  // the TARGET entry's offset while this screen is still shown.
  const left = useRef<{ to: string; y: number } | null>(null);
  useLayoutEffect(() => {
    const onPop = () => {
      const to = entryKey();
      left.current = to === key.current ? null : { to, y: where() };
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const path = location.pathname;
  useLayoutEffect(() => {
    readyRef.current = ready;
    pathRef.current = path;
    const arrivedKey = location.key;
    const remount =
      current !== null && current.key === arrivedKey && current.path === path;
    current = { key: arrivedKey, path };
    left.current = null;
    if (!remount) {
      const stale =
        document.activeElement === document.body
          ? null
          : document.activeElement;
      if (navigationType !== 'POP') {
        scrollTop();
        pending.current = { focus: true, y: null, stale };
      } else if (lastPopKey === arrivedKey) {
        const record = records.find(
          (r) =>
            r.key === arrivedKey && r.path === path && isSameSession(r.stamp),
        );
        if (record === undefined) scrollTop();
        else window.scrollTo(0, record.y);
        pending.current = { focus: true, y: record?.y ?? null, stale };
      }
      settle.current();
    }

    // Until settled: the page growing (POP placement), a closing layer
    // lifting aria-hidden/inert or leaving (focus). Ended by user intent.
    const cancel = () => {
      pending.current = null;
      stop();
    };
    const observers: { disconnect(): void }[] = [];
    const onChange = () => {
      settle.current();
      if (pending.current === null) stop();
    };
    if (typeof ResizeObserver !== 'undefined') {
      const resized = new ResizeObserver(onChange);
      resized.observe(document.body);
      observers.push(resized);
    }
    if (typeof MutationObserver !== 'undefined') {
      const hidden = new MutationObserver(onChange);
      hidden.observe(document.body, {
        subtree: true,
        attributeFilter: ['aria-hidden', 'inert'],
      });
      // A layer's portal leaving the page (focus falls back to the body).
      const portals = new MutationObserver(onChange);
      portals.observe(document.body, { childList: true });
      observers.push(portals);
      observers.push(hidden);
    }
    const intents = ['wheel', 'touchstart', 'keydown', 'pointerdown'];
    for (const t of intents)
      window.addEventListener(t, cancel, { passive: true, capture: true });
    function stop() {
      observers.forEach((o) => o.disconnect());
      observers.length = 0;
      for (const t of intents)
        window.removeEventListener(t, cancel, { capture: true });
    }
    if (pending.current === null) stop();

    return () => {
      stop();
      // Still on this pathname: a remount (StrictMode's replay keeps what
      // is still pending), not a leave.
      if (window.location.pathname === path) return;
      const here = where();
      pending.current = null;
      if (current !== null && current.path === path) current = null;
      if (!isSameSession(stamp)) return;
      const at =
        left.current !== null && left.current.to === entryKey()
          ? left.current.y
          : here;
      records = [
        ...records.filter((r) => r.key !== key.current),
        { stamp, key: key.current, path, y: at },
      ].slice(-MAX);
    };
    // Only a new pathname is a new entry — see the module comment.
  }, [path]);

  // Settled after arrival (loading → ready): focus the title now.
  useLayoutEffect(() => {
    readyRef.current = ready;
    if (ready) settle.current();
  }, [ready]);
}
