import { useContext } from 'react';
import {
  UNSAFE_DataRouterContext,
  useLocation,
  useNavigate,
  type Location,
} from 'react-router-dom';
import { isSameSession, sessionStamp } from '../auth';
import { useLeaveGuardApi } from './unsavedChanges';

/**
 * Completion navigation (issue #252): a finished task must not stay behind
 * in Back/Forward history.
 *
 * - Ordinary browsing (list → item, Back, Forward) keeps plain pushes.
 * - A list that opens an item records itself on the pushed entry
 *   (`useOriginState()`): full href, its own history state, history index and
 *   key. That record — plus the current entry sitting exactly one index
 *   above it — is the only proof that the entry below is the origin.
 * - ADVANCE to the next task replaces the finished entry and carries the
 *   record along (same index, proof still holds).
 * - RETURN to a proven origin: replace the finished entry with a copy of the
 *   origin, then POP onto the real origin entry. Back then reaches what
 *   preceded the origin; Forward reaches the valid copy, never the finished
 *   task; the next push truncates it. Without proof (deep link, index
 *   mismatch, no record) the finished entry is only replaced by a fallback.
 * - An origin the task itself destroyed (`originGone`) is rewritten too:
 *   replace → POP → replace that origin entry with the substitute.
 *
 * Browser history cannot be pruned: only the task's own entry and its
 * recorded origin are rewritten, never older visits. Every step after the
 * first is conditional — it runs only if the previous step committed the
 * navigation THIS chain started (an owned state nonce / the expected POP
 * index), in the same live shell and session, with no blocker, pending
 * operation or dirty form. Any interruption ends the chain for good; the
 * entry left behind is always a safe replacement, never a late surprise.
 */

export interface OriginRecord {
  /** pathname + search of the origin entry when it opened the item. */
  href: string;
  /** The origin entry's own history state (its own origin record etc.). */
  state: unknown;
  /** The origin's browser history index; null when unknown (no proof). */
  idx: number | null;
  key: string;
}

const ORIGIN = 'hbkOrigin';
const RETURN_NONCE = 'hbkReturn';

/** react-router's browser history stamps `idx` on every entry it creates. */
function historyIdx(): number | null {
  const idx: unknown = (window.history.state as { idx?: unknown } | null)?.idx;
  return typeof idx === 'number' ? idx : null;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

export function readOrigin(state: unknown): OriginRecord | null {
  if (!isObject(state)) return null;
  const o = state[ORIGIN];
  if (
    !isObject(o) ||
    typeof o.href !== 'string' ||
    typeof o.key !== 'string' ||
    !(o.idx === null || typeof o.idx === 'number')
  )
    return null;
  return { href: o.href, state: o.state, idx: o.idx, key: o.key };
}

export function pathOf(href: string): string {
  return href.split(/[?#]/)[0];
}

/** State for a push that opens an item FROM this location. */
export function useOriginState(): { [ORIGIN]: OriginRecord } {
  const location = useLocation();
  return {
    [ORIGIN]: {
      href: location.pathname + location.search,
      state: location.state as unknown,
      idx: historyIdx(),
      key: location.key,
    },
  };
}

/** The origin recorded on the current entry, if any (not yet proof). */
export function useOrigin(): OriginRecord | null {
  return readOrigin(useLocation().state);
}

/** The entry right below the current one is the recorded origin. */
function provenParent(origin: OriginRecord | null): origin is OriginRecord & {
  idx: number;
} {
  const idx = historyIdx();
  return origin !== null && origin.idx !== null && idx === origin.idx + 1;
}

type RouterState = {
  location: Location;
  historyAction: string;
  navigation: { state: string; location?: Location };
  blockers: Map<string, { state: string }>;
};

type Router = {
  state: RouterState;
  subscribe: (fn: (s: RouterState) => void) => () => void;
  navigate: (
    to: string | number,
    opts?: { replace?: boolean; state?: unknown },
  ) => Promise<void>;
};

/** A committed location this chain produced, re-proven before every later
 *  step: same entry (key), same history index, router idle. */
interface Snapshot {
  key: string;
  idx: number;
}

/** One return chain's lifetime: cancelled by the shell's end (sign-out,
 *  forced 401) — the only exits that may bring no router update. */
interface ChainScope {
  cancelled: boolean;
  /** The active step's abort, if one is waiting. */
  abort: (() => void) | null;
  live: () => boolean;
  quiet: () => boolean;
}

function blocked(s: RouterState): boolean {
  return [...s.blockers.values()].some((b) => b.state === 'blocked');
}

/** The router still stands exactly where the previous step left it, in a
 *  live, quiet shell — checked synchronously right before a navigate. */
function stillAt(router: Router, scope: ChainScope, snap: Snapshot): boolean {
  const s = router.state;
  return (
    !scope.cancelled &&
    scope.live() &&
    scope.quiet() &&
    !blocked(s) &&
    s.navigation.state === 'idle' &&
    s.location.key === snap.key &&
    historyIdx() === snap.idx
  );
}

/** Run one step: re-prove `from` (null: the first step, which is the
 *  task's own leave and always starts — through the route blocker, like
 *  any navigation), subscribe, start the navigation, and
 *  settle with the committed location if it is this step's own `expected`
 *  one — else null. It settles (and unsubscribes) on the first of: a
 *  committed location change, an in-flight navigation to anything but
 *  `expected`, a blocker, a dead scope (checked on every router update and
 *  on the shell's end via `scope.abort`), or a rejected navigate. */
function step(
  router: Router,
  scope: ChainScope,
  from: Snapshot | null,
  start: () => Promise<void>,
  inFlight: (loc: Location) => boolean,
  expected: (s: RouterState) => boolean,
): Promise<Snapshot | null> {
  if (from !== null && !stillAt(router, scope, from))
    return Promise.resolve(null);
  const startKey = router.state.location.key;
  return new Promise((resolve) => {
    let done = false;
    const finish = (snap: Snapshot | null) => {
      if (done) return;
      done = true;
      unsubscribe();
      scope.abort = null;
      resolve(snap);
    };
    const unsubscribe = router.subscribe((s) => {
      if (scope.cancelled || !scope.live() || blocked(s)) return finish(null);
      if (s.navigation.state !== 'idle') {
        const loc = s.navigation.location;
        if (loc !== undefined && !inFlight(loc)) finish(null);
        return;
      }
      if (s.location.key === startKey) return;
      const idx = historyIdx();
      finish(expected(s) && idx !== null ? { key: s.location.key, idx } : null);
    });
    scope.abort = () => finish(null);
    start().catch(() => finish(null));
  });
}

let nonceSeq = 0;
const nextNonce = () => `${Date.now().toString(36)}-${++nonceSeq}`;

function withNonce(state: unknown, nonce: string): Record<string, unknown> {
  return { ...(isObject(state) ? state : {}), [RETURN_NONCE]: nonce };
}

function hasNonce(loc: Location, nonce: string): boolean {
  return isObject(loc.state) && loc.state[RETURN_NONCE] === nonce;
}

export interface ReturnOptions {
  /** Where to go without a proven origin (deep link, cross-section). */
  fallback: string;
  /** The origin must look like this to be returned to (else: fallback). */
  acceptOrigin?: (originPath: string) => boolean;
  /** The task destroyed what the origin shows: this replaces both entries. */
  originGone?: string;
}

export function useCompletionNavigation() {
  const location = useLocation();
  const navigate = useNavigate();
  const dataRouter = useContext(UNSAFE_DataRouterContext);
  const api = useLeaveGuardApi();
  const origin = readOrigin(location.state);

  /** Next task: replace the finished entry, keep the origin record. */
  const advance = (to: string) => {
    void navigate(to, {
      replace: true,
      state: origin ? { [ORIGIN]: origin } : null,
    });
  };

  /** Leave a finished task for its origin — see the module comment. */
  const returnTo = ({ fallback, acceptOrigin, originGone }: ReturnOptions) => {
    const router = dataRouter?.router as unknown as Router | undefined;
    const accepted =
      origin !== null &&
      (acceptOrigin === undefined || acceptOrigin(pathOf(origin.href)));
    const here = historyIdx();
    if (
      router === undefined ||
      !accepted ||
      !provenParent(origin) ||
      here === null
    ) {
      void navigate(accepted && originGone ? originGone : fallback, {
        replace: true,
      });
      return;
    }
    const o = origin;
    const originPath = pathOf(o.href);
    const stamp = sessionStamp();
    const scope: ChainScope = {
      cancelled: false,
      abort: null,
      live: () => api.isAlive() && isSameSession(stamp),
      quiet: () =>
        api.pendingLabels().length === 0 && api.dirtyEntries().length === 0,
    };
    const offShellEnd = api.onShellEnd(() => {
      scope.cancelled = true;
      scope.abort?.();
    });
    const copyHref = originGone ?? o.href;
    const copyState = originGone ? null : o.state;

    void (async () => {
      // 1. The finished entry becomes a valid copy of the origin — proven
      //    ours by a nonce only this chain writes.
      const n1 = nextNonce();
      const replaced = await step(
        router,
        scope,
        null,
        () =>
          router.navigate(copyHref, {
            replace: true,
            state: withNonce(copyState, n1),
          }),
        (loc) => hasNonce(loc, n1),
        (s) =>
          s.historyAction === 'REPLACE' &&
          hasNonce(s.location, n1) &&
          historyIdx() === here,
      );
      if (replaced === null) return;
      // 2. POP onto the origin entry. Proof: the entry at the origin's
      //    index with the origin's pathname. Not its key: an in-place query
      //    replace there (segment switch) legitimately re-keys it, and
      //    nothing but a replace AT that index can change it while our
      //    entry — pushed from it — still sits right above.
      const popped = await step(
        router,
        scope,
        replaced,
        () => router.navigate(-1),
        (loc) => loc.pathname === originPath,
        (s) =>
          s.historyAction === 'POP' &&
          s.location.pathname === originPath &&
          historyIdx() === o.idx,
      );
      if (popped === null || originGone === undefined) return;
      // 3. That origin shows the destroyed object: overwrite it in place.
      const n3 = nextNonce();
      await step(
        router,
        scope,
        popped,
        () =>
          router.navigate(originGone, {
            replace: true,
            state: withNonce(null, n3),
          }),
        (loc) => hasNonce(loc, n3),
        (s) => hasNonce(s.location, n3) && historyIdx() === o.idx,
      );
    })().finally(offShellEnd);
  };

  return { origin, advance, returnTo };
}
