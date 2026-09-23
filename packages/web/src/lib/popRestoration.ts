/**
 * Blocked-POP restoration (issue #370). When the route blocker refuses a
 * browser traversal (Back/Forward), react-router puts the entry back with
 * `history.go(-delta)` and treats the NEXT `popstate` — whatever it is — as
 * that restoration. A second traversal already queued by the browser (two
 * Backs in one task) arrives first: the router swallows it as "restored"
 * while the browser has moved on, and its own relative `go` then lands
 * elsewhere or is dropped (Chromium drops it). The address, `history.state`
 * and the rendered route then disagree for good.
 *
 * An EPISODE runs from a refused POP until the browser stands on the
 * router's own entry again with the router's restoration delivered:
 *
 * - Only a `popstate` that lands on the router's entry (its current location
 *   key) while the router still awaits its restoration reaches the router.
 * - Any other traversal in the episode is SPENT: stopped before the router
 *   (and every other listener) sees it. A burst is thereby coalesced into
 *   the first, refused attempt — one layer dismiss, one refusal, one discard
 *   question — never a second attempt against a layer or route whose first
 *   answer the operator has not seen yet.
 * - Once no traversal has arrived for `SETTLE_MS` (also when the router's
 *   own restoration never arrives), the browser is taken back to the
 *   router's entry with one relative `go` measured from the entry it stands
 *   on NOW — never from queued deltas, which the browser may drop. That
 *   landing is the router's restoration, so its index, restore promise and
 *   a later `proceed()` stay exact. No entry is written or rewritten.
 * - A PUSH/REPLACE requested during an episode would be written at whatever
 *   entry the browser is passing through (truncating or overwriting real
 *   history), so the route guard holds it (`busy()`) and decides it at
 *   `onEnd` — only once the entry is restored.
 * - Bounded: after `MAX_RESTORES` refused/dropped restores (or when the
 *   router's entry index is unknown) the episode is STRANDED, not ended:
 *   held navigations are told it failed (the guard cancels them), new ones
 *   are refused, and traversals other than onto the router's entry stay
 *   spent. Nothing is written at a wrong entry; a browser that refuses
 *   every traversal leaves address and route apart until a traversal lands
 *   on the router's entry (the operator's own Back/Forward), which ends it.
 *
 * One controller per browser router, for the router's lifetime: the shell
 * (and its route guard) can unmount mid-episode (sign-out, a forced 401)
 * while the router lives on, and its restoration must still complete.
 * Arming requires the browser to actually stand on the refused entry, so a
 * memory router (tests) never arms.
 */

/** Quiet time after the refused POP or the last spent traversal before the
 *  entry is restored. Browser traversals land within a few ms of each
 *  other; a traversal inside this window is spent with the burst. */
export const SETTLE_MS = 150;
/** Restore attempts per episode before it is stranded (a browser that
 *  keeps dropping them). */
const MAX_RESTORES = 3;

interface HistoryEntry {
  key: string;
  idx: number;
}

/** What this needs of react-router's data router. */
export interface RestorableRouter {
  state: { location: { key: string } };
  subscribe: (fn: (state: { location: { key: string } }) => void) => () => void;
}

export interface PopRestoration {
  /** The route blocker just refused a POP onto `nextKey`. */
  blocked: (nextKey: string) => void;
  /** An episode is running: the browser may not stand on the router's
   *  entry, or the router still awaits its restoration. */
  busy: () => boolean;
  /** Run `fn(true)` once the browser stands on the router's entry again
   *  (at once when no episode runs), or `fn(false)` when the episode is
   *  stranded (at once when it already is); returns the unregister. */
  onEnd: (fn: (restored: boolean) => void) => () => void;
}

function browserEntry(): HistoryEntry | null {
  const state = window.history.state as { key?: unknown; idx?: unknown } | null;
  const idx = state?.idx;
  if (typeof idx !== 'number') return null;
  const key = state?.key;
  return { key: typeof key === 'string' ? key : 'default', idx };
}

const controllers = new WeakMap<RestorableRouter, PopRestoration>();
const armed = new Set<(e: PopStateEvent) => void>();

// Registered at module load, in the capture phase: ahead of the router's own
// (bubble) listener, which is only added when the router is created.
if (typeof window !== 'undefined') {
  window.addEventListener(
    'popstate',
    (e) => {
      for (const onPop of [...armed]) onPop(e);
    },
    true,
  );
}

export function popRestoration(router: RestorableRouter): PopRestoration {
  let controller = controllers.get(router);
  if (controller === undefined) {
    controller = createPopRestoration(router);
    controllers.set(router, controller);
  }
  return controller;
}

function createPopRestoration(router: RestorableRouter): PopRestoration {
  // The router's entry: its location key and that entry's history index,
  // taken whenever a committed location is the one the browser stands on.
  let shown: HistoryEntry | null = null;
  const observe = (key: string) => {
    const at = browserEntry();
    if (at !== null && at.key === key) shown = at;
  };
  observe(router.state.location.key);
  router.subscribe((state) => observe(state.location.key));

  let episode: {
    /** The router will swallow the next pop that reaches it. */
    awaiting: boolean;
    /** A traversal was spent or a restore issued: further pops may come. */
    spent: boolean;
    restores: number;
    /** Restoring has failed: wait for the operator's own traversal. */
    stranded: boolean;
  } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const endListeners = new Set<(restored: boolean) => void>();

  const notify = (restored: boolean) => {
    const listeners = [...endListeners];
    endListeners.clear();
    for (const fn of listeners) fn(restored);
  };

  const wait = () => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(settle, SETTLE_MS);
  };

  const end = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    episode = null;
    armed.delete(onPop);
    notify(true);
  };

  const strand = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (episode !== null) episode.stranded = true;
    notify(false);
  };

  function settle() {
    timer = null;
    if (episode === null || episode.stranded) return;
    const routerKey = router.state.location.key;
    const at = browserEntry();
    // On the router's entry with nothing more arriving: done. (Awaiting
    // here would mean the browser returned without a popstate — no
    // browser does; nothing else writes history during an episode.)
    if (at !== null && at.key === routerKey) {
      end();
      return;
    }
    if (
      at === null ||
      shown === null ||
      shown.key !== routerKey ||
      episode.restores >= MAX_RESTORES
    ) {
      strand();
      return;
    }
    episode.restores += 1;
    episode.spent = true;
    window.history.go(shown.idx - at.idx);
    // Dropped by the browser → measured and retried after the next quiet.
    wait();
  }

  function onPop(e: PopStateEvent) {
    if (episode === null) return;
    const at = browserEntry();
    if (at !== null && at.key === router.state.location.key) {
      if (episode.awaiting) {
        // The router's restoration: it reaches the router.
        episode.awaiting = false;
        if (episode.spent && !episode.stranded) wait();
        else end();
        return;
      }
      // Already restored; the router must not see a move onto its own entry.
      e.stopImmediatePropagation();
      if (episode.stranded) end();
      else wait();
      return;
    }
    e.stopImmediatePropagation();
    episode.spent = true;
    if (!episode.stranded) wait();
  }

  return {
    blocked: (nextKey) => {
      const at = browserEntry();
      // Only when the browser demonstrably LEFT the router's known entry for
      // the refused one: react-router restores only a traversal with a
      // history index, and a memory router never moves the browser (even
      // where its keys happen to match what the browser shows).
      if (
        at === null ||
        at.key !== nextKey ||
        shown === null ||
        shown.key !== router.state.location.key ||
        shown.key === at.key
      )
        return;
      episode = { awaiting: true, spent: false, restores: 0, stranded: false };
      armed.add(onPop);
      wait();
    },
    busy: () => episode !== null,
    onEnd: (fn) => {
      if (episode === null || episode.stranded) {
        fn(episode === null);
        return () => undefined;
      }
      endListeners.add(fn);
      return () => {
        endListeners.delete(fn);
      };
    },
  };
}
