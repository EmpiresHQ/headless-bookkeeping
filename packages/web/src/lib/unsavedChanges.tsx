import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { flushSync } from 'react-dom';
import {
  UNSAFE_DataRouterContext,
  useBlocker,
  type BlockerFunction,
} from 'react-router-dom';
import type { UnauthorizedError } from '../auth';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import {
  createModalLayerRegistry,
  ModalLayerContext,
  type ModalLayer,
  type ModalLayerRegistry,
} from './modalLayers';
import { popRestoration } from './popRestoration';
import { toastWait } from '../ui/toast';

/**
 * Unsaved-input guard (issue #250). One rule for every editable form: input
 * the operator typed is never dropped silently — closing the sheet (Escape,
 * backdrop, swipe, a Cancel button), leaving the route (links, Back/forward,
 * a same-screen move to another object), explicit sign-out and a page
 * refresh/close all ask first. Nothing is persisted: drafts of amounts,
 * secrets and chosen files live only in component state and die with it.
 *
 * - A form calls `useUnsavedChanges({label, values, baseline})`. It is dirty
 *   while `values` differ structurally from `baseline` — so a form edited back
 *   to where it started does not nag. Forms whose initial values arrive
 *   asynchronously (prefill, refetch) DERIVE `baseline` from the same query
 *   data the prefill uses, so a prefill or refetch is never a user change.
 * - `release()` marks the CURRENT values as not-unsaved, synchronously (a
 *   ref, not state): a success handler calls it before it closes/navigates
 *   and the Sheet veto, the route blocker and `beforeunload` all read the
 *   live getter. Any later edit that moves away from the released snapshot
 *   is dirty again (inline forms stay open after save). A failed save simply
 *   does not call it, so the values and the guard both stay.
 * - `UnsavedChangesProvider` (AppLayout) owns the registry, the single
 *   route blocker, the `beforeunload` listener and one shared discard
 *   dialog. It unmounts with the authenticated shell, so a forced 401 drops
 *   every draft with it; explicit sign-out goes through `confirmLeave`.
 *
 * Route blocking needs a data router (`createBrowserRouter` in production);
 * under a plain <MemoryRouter> (isolated component tests) there is honestly
 * no route guard — sheet, sign-out and unload guards still work.
 *
 * Pending operations (issue #251, lib/pendingOperation) register here too:
 * while one is in flight the same exits are REFUSED outright — route leave
 * and sign-out with a protected-wait status, refresh/close with the
 * browser's prompt even when the form is clean — so its completion can
 * never act on a screen the operator has moved on to.
 *
 * Modal layers (issue #267, lib/modalLayers) register here too: while one is
 * open, Back/Forward closes the top layer (through its own guards) and the
 * route stays — see RouteLeaveGuard.
 */

export interface UnsavedEntry {
  label: string;
  isDirty: () => boolean;
  release: () => void;
}

/** One in-flight operation (lib/pendingOperation). */
export interface PendingEntry {
  label: string;
}

interface UnsavedChangesApi {
  register: (entry: UnsavedEntry) => () => void;
  /** Register an in-flight operation; the returned release is idempotent. */
  registerPending: (entry: PendingEntry) => () => void;
  pendingLabels: () => string[];
  /** Open modal layers (Sheet, ConfirmDialog, preview lightbox). */
  openLayers: () => number;
  /** A completion chain's start: the finished task's still-open layers stop
   *  counting (lib/modalLayers retireOpen); returns the undo. */
  retireOpenLayers: () => () => void;
  /** False once the authenticated shell (this provider) has unmounted. */
  isAlive: () => boolean;
  /** Run `fn` when the shell unmounts (issue #252: a return-navigation
   *  chain ends with it); returns the unregister. */
  onShellEnd: (fn: () => void) => () => void;
  /** Route a 401 from an operation to the shell's session handling. */
  onUnauthorized: (error: UnauthorizedError) => void;
  dirtyEntries: () => UnsavedEntry[];
  confirmDiscard: (labels: string[]) => Promise<boolean>;
  /** Run `fn` now if nothing is dirty; else after the operator confirms
   *  discarding every dirty form (which are then released). */
  confirmLeave: (fn: () => void) => void;
}

/** The protected-wait status: an aria-live toast with a fixed id, so
 *  repeated attempts update one message instead of stacking. */
export const PENDING_TOAST_ID = 'pending-operation';

function announcePending(labels: string[]): void {
  const what = labels.map((l) => `“${l}”`).join(', ');
  toastWait(
    PENDING_TOAST_ID,
    `${what} is still saving — wait for it to finish before leaving.`,
  );
}

const UnsavedChangesContext = createContext<UnsavedChangesApi | null>(null);
/** Bumped by every confirmed route discard — AppLayout keys the routed
 *  subtree with it (see RouteLeaveGuard). */
const RouteDiscardEpochContext = createContext(0);

/** Key for the routed subtree: changes when a route leave was confirmed as
 *  a discard, so the discarded screen remounts from its baseline. */
export function useRouteDiscardEpoch(): number {
  return useContext(RouteDiscardEpochContext);
}

/** Structural equality for form values: primitives by Object.is, arrays and
 *  plain objects by content, Sets by membership; anything else (File,
 *  entity objects) by identity. */
export function sameValues(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => sameValues(v, b[i]));
  }
  if (a instanceof Set && b instanceof Set) {
    return a.size === b.size && [...a].every((v) => b.has(v));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return (
      ka.length === kb.length &&
      ka.every(
        (k) =>
          Object.prototype.hasOwnProperty.call(b, k) && sameValues(a[k], b[k]),
      )
    );
  }
  return false;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function uniqueLabels(entries: UnsavedEntry[]): string[] {
  return [...new Set(entries.map((e) => e.label))];
}

export function UnsavedChangesProvider({
  children,
  onUnauthorized,
}: {
  children: ReactNode;
  /** The shell's session handler (Root) — required: operations must never
   *  swallow a current 401 for lack of a route to sign-out. */
  onUnauthorized: (error: UnauthorizedError) => void;
}) {
  const entries = useRef(new Set<UnsavedEntry>());
  const pendingOps = useRef(new Set<PendingEntry>());
  const alive = useRef(true);
  const shellEndListeners = useRef(new Set<() => void>());
  const onUnauthorizedRef = useRef(onUnauthorized);
  onUnauthorizedRef.current = onUnauthorized;
  const [registered, setRegistered] = useState(0);
  const pendingRef = useRef<{
    labels: string[];
    resolve: (ok: boolean) => void;
  } | null>(null);
  const [pending, setPending] = useState<string[] | null>(null);
  const [routeEpoch, setRouteEpoch] = useState(0);
  const bumpRouteEpoch = useCallback(() => setRouteEpoch((n) => n + 1), []);

  const layers = useMemo(createModalLayerRegistry, []);

  const settle = useCallback((ok: boolean) => {
    const p = pendingRef.current;
    pendingRef.current = null;
    setPending(null);
    p?.resolve(ok);
  }, []);

  const api = useMemo<UnsavedChangesApi>(() => {
    const dirtyEntries = () => [...entries.current].filter((e) => e.isDirty());
    const pendingLabels = () => [
      ...new Set([...pendingOps.current].map((p) => p.label)),
    ];
    const recount = () =>
      setRegistered(entries.current.size + pendingOps.current.size);
    const confirmDiscard = (labels: string[]) =>
      new Promise<boolean>((resolve) => {
        // A newer request supersedes an unanswered one (answered "keep").
        pendingRef.current?.resolve(false);
        pendingRef.current = { labels, resolve };
        setPending(labels);
      });
    return {
      register: (entry) => {
        entries.current.add(entry);
        recount();
        return () => {
          entries.current.delete(entry);
          recount();
        };
      },
      registerPending: (entry) => {
        pendingOps.current.add(entry);
        recount();
        return () => {
          if (!pendingOps.current.delete(entry)) return;
          if (alive.current) recount();
        };
      },
      pendingLabels,
      openLayers: () => layers.count(),
      retireOpenLayers: () => layers.retireOpen(),
      isAlive: () => alive.current,
      onShellEnd: (fn) => {
        shellEndListeners.current.add(fn);
        return () => {
          shellEndListeners.current.delete(fn);
        };
      },
      onUnauthorized: (error) => onUnauthorizedRef.current(error),
      dirtyEntries,
      confirmDiscard,
      confirmLeave: (fn) => {
        const pending = pendingLabels();
        if (pending.length > 0) {
          announcePending(pending);
          return;
        }
        const dirty = dirtyEntries();
        if (dirty.length === 0) {
          fn();
          return;
        }
        void confirmDiscard(uniqueLabels(dirty)).then((ok) => {
          if (!ok) return;
          dirty.forEach((e) => e.release());
          fn();
        });
      },
    };
  }, [layers]);

  // Unmount (sign-out, forced 401): answer any open question "keep" so no
  // caller's continuation runs later. Registered forms unregister
  // themselves (their own cleanup), so the registry is not touched here —
  // that also keeps StrictMode's effect replay from dropping live entries.
  // Layout effect: the shell's unmount (sign-out, forced 401) ends every
  // operation scope synchronously in the removing commit.
  useLayoutEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      const ended = [...shellEndListeners.current];
      shellEndListeners.current.clear();
      for (const fn of ended) fn();
      pendingRef.current?.resolve(false);
      pendingRef.current = null;
    };
  }, []);

  // Refresh / tab close / external navigation: the browser's own standard
  // confirmation. Attached only while some guarded form is mounted or an
  // operation is in flight; the handler re-reads the live getters, so it
  // prompts only while something is dirty or pending (even a clean form's
  // save), and a synchronous release() counts immediately. The browser may
  // still skip the prompt (no prior user gesture) and a killed tab cannot
  // be stopped: then the request's outcome is unknown to the client.
  useEffect(() => {
    if (registered === 0) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (api.dirtyEntries().length === 0 && api.pendingLabels().length === 0)
        return;
      e.preventDefault();
      // Legacy browsers (and some current ones) need returnValue set.
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [registered, api]);

  const dataRouter = useContext(UNSAFE_DataRouterContext);

  return (
    <UnsavedChangesContext.Provider value={api}>
      <ModalLayerContext.Provider value={layers}>
        <RouteDiscardEpochContext.Provider value={routeEpoch}>
          {children}
        </RouteDiscardEpochContext.Provider>
        {dataRouter !== null && (
          <RouteLeaveGuard
            api={api}
            layers={layers}
            onDiscarded={bumpRouteEpoch}
          />
        )}
        <ConfirmDialog
          open={pending !== null}
          onOpenChange={(o) => {
            if (!o) settle(false);
          }}
          title="Discard unsaved changes?"
          body={
            <>
              Your changes in{' '}
              <span className="font-semibold text-ink">
                {(pending ?? []).join(', ')}
              </span>{' '}
              have not been saved and will be lost.
            </>
          }
          cancelLabel="Keep editing"
          confirmLabel="Discard"
          destructive
          onConfirm={() => settle(true)}
        />
      </ModalLayerContext.Provider>
    </UnsavedChangesContext.Provider>
  );
}

/** The app's single router blocker (react-router allows one). Blocks a
 *  PATHNAME change — push, replace, Back/forward, a same-screen move to
 *  another object id — while any registered form is dirty or any operation
 *  is in flight. Search-only changes (?seg=, filters) never unmount a form
 *  and are not blocked. A pending operation refuses the move outright
 *  (protected wait) — there is nothing to discard mid-save.
 *
 *  A confirmed discard must really discard. The navigation that follows runs
 *  in a React transition: while the target's lazy chunk (or a suspending
 *  screen) loads, React keeps the OLD screen — the discarded form instance —
 *  on display, and a quick reversal (Back → Forward) would land on it again
 *  with its values intact but released as clean. So a discard first bumps
 *  the routed subtree's epoch (`onDiscarded`): an URGENT update that commits
 *  at once on the still-current location and remounts the screen from its
 *  baseline, before the transition to the next route is even started.
 *
 *  Modal layers first (issue #267): a history traversal (POP — browser Back
 *  or Forward, any pathname or query) while a layer is open is blocked too.
 *  The router has already put the URL back; the traversal is SPENT on one
 *  dismiss request to the top layer — the same as its Escape/Close, so its
 *  busy refusal and dirty question apply — and the route stays. Layers never
 *  write history, so there is nothing to undo after a close and a Forward is
 *  consumed the same way (a sheet never reopens from history). PUSH/REPLACE
 *  (links, a success's close+navigate, completion chains) are not affected
 *  by layers.
 *
 *  A refused POP is put back by the router (lib/popRestoration, issue #370):
 *  further traversals that arrive before that restoration has landed — a
 *  burst of Backs — are spent with this attempt, and the browser is brought
 *  back to the router's own entry, so address, history state and route
 *  never disagree. A PUSH/REPLACE the guard lets through is held back
 *  meanwhile (it would be written wherever the browser is passing through)
 *  and proceeds, unchanged, once the entry is restored. */
function RouteLeaveGuard({
  api,
  layers,
  onDiscarded,
}: {
  api: UnsavedChangesApi;
  layers: ModalLayerRegistry;
  onDiscarded: () => void;
}) {
  const dataRouter = useContext(UNSAFE_DataRouterContext);
  // Why the latest attempt was blocked, keyed by its target entry.
  // A layer-blocked attempt: its target entry and the layer that was on top
  // WHEN it was blocked — the only layer that attempt may dismiss.
  const layerBlock = useRef<{ key: string; layer: ModalLayer | null } | null>(
    null,
  );
  const restoration = useMemo(
    () => (dataRouter === null ? null : popRestoration(dataRouter.router)),
    [dataRouter],
  );
  // A PUSH/REPLACE held back while a refused POP is being restored: its
  // target entry. The router proceeds with it once the browser stands on
  // the router's entry again.
  const deferred = useRef<string | null>(null);
  const blocker = useBlocker(
    useCallback<BlockerFunction>(
      ({ currentLocation, nextLocation, historyAction }) => {
        if (historyAction === 'POP' && layers.count() > 0) {
          layerBlock.current = { key: nextLocation.key, layer: layers.top() };
          deferred.current = null;
          restoration?.blocked(nextLocation.key);
          return true;
        }
        const leave =
          currentLocation.pathname !== nextLocation.pathname &&
          (api.pendingLabels().length > 0 || api.dirtyEntries().length > 0);
        if (leave) {
          layerBlock.current = null;
          deferred.current = null;
          if (historyAction === 'POP') restoration?.blocked(nextLocation.key);
          return true;
        }
        if (historyAction !== 'POP' && restoration?.busy() === true) {
          deferred.current = nextLocation.key;
          return true;
        }
        return false;
      },
      [api, layers, restoration],
    ),
  );

  useEffect(() => {
    if (blocker.state !== 'blocked') return;
    // The EXACT blocked attempt this question is about. Another navigation
    // (a rapid Back/Forward) can complete before the answer and reset every
    // blocker in the router's state, while React has not re-rendered yet —
    // so the continuation acts only if the router still holds this very
    // blocker object (react-router keeps blocker objects by identity).
    const asked = blocker;
    const stillAsked = () =>
      dataRouter !== null &&
      [...dataRouter.router.state.blockers.values()].includes(asked);
    const attempt = layerBlock.current;
    if (attempt !== null && attempt.key === asked.location.key) {
      layerBlock.current = null;
      // Superseded by a newer attempt: that one owns the answer.
      if (!stillAsked()) return;
      asked.reset();
      // Only the layer this attempt was blocked for. Gone meanwhile (closed,
      // or a menu handed off to a new sheet): the traversal is simply spent
      // — a newer layer is never dismissed by an older Back.
      const layer = attempt.layer;
      if (layer !== null && layers.has(layer) && !layer.dismiss()) {
        const busy = api.pendingLabels();
        if (busy.length > 0) announcePending(busy);
      }
      return;
    }
    let live = true;
    let off = () => {};
    // Nothing is written to history while a refused POP is still being
    // restored (lib/popRestoration): an accepted navigation — however fast
    // the answer — goes ahead only once the browser stands on the router's
    // entry again.
    const whenRestored = (fn: (restored: boolean) => void) => {
      off();
      off = () => {};
      if (restoration === null) fn(true);
      else off = restoration.onEnd(fn);
    };
    const answer = (ok: boolean) => {
      if (!live || !stillAsked()) return;
      if (!ok) {
        asked.reset();
        return;
      }
      // Never restored (stranded): cancelled — it would write at a wrong
      // entry. Whatever was discarded stays discarded.
      whenRestored((restored) => {
        if (!live || !stillAsked()) return;
        if (restored) asked.proceed();
        else asked.reset();
      });
    };
    // The guard's decision on this attempt, taken against the state NOW.
    const decide = () => {
      const leaving =
        dataRouter !== null &&
        dataRouter.router.state.location.pathname !== asked.location.pathname;
      if (!leaving) {
        answer(true);
        return;
      }
      const pending = api.pendingLabels();
      if (pending.length > 0) {
        announcePending(pending);
        answer(false);
        return;
      }
      const dirty = api.dirtyEntries();
      if (dirty.length === 0) {
        answer(true);
        return;
      }
      void api.confirmDiscard(uniqueLabels(dirty)).then((ok) => {
        if (!live) return;
        if (ok) {
          // The discard itself stands even if the navigation it was for has
          // been superseded: release, and remount the screen from baseline.
          dirty.forEach((e) => e.release());
          flushSync(onDiscarded);
        }
        answer(ok);
      });
    };
    if (deferred.current === asked.location.key) {
      // Held back during a restoration, not refused: decided when it ends,
      // against whatever is pending or dirty by then — a form opened, edited
      // or saving meanwhile is guarded as for any other navigation.
      deferred.current = null;
      whenRestored((restored) => {
        if (!live || !stillAsked()) return;
        if (restored) decide();
        else asked.reset();
      });
    } else {
      decide();
    }
    return () => {
      live = false;
      off();
    };
    // `blocker` changes identity exactly when its state does.
  }, [blocker, api, layers, onDiscarded, dataRouter, restoration]);

  return null;
}

/** What a container (Sheet) needs from a form's guard to veto a dismiss. */
export interface DismissGuard {
  /** Live read; reflects release() synchronously. */
  isDirty: () => boolean;
  /** Resolves true (after releasing) when clean or the operator confirms
   *  discarding THIS form; false when they keep editing. */
  confirmDiscard: () => Promise<boolean>;
}

export interface UnsavedGuard<T = unknown> extends DismissGuard {
  /** Render-time dirty flag (for display only; decisions use isDirty()). */
  dirty: boolean;
  /** The current values are saved (or knowingly discarded). Pass `values`
   *  when the handler also sets the fields to the saved form in the same
   *  tick (not yet committed). */
  release: (values?: T) => void;
}

/**
 * Register one form with the unsaved-changes guard. `active` scopes it —
 * a sheet passes its `open` flag so a closed-but-still-mounted sheet (kept
 * for its exit animation) never blocks anything.
 *
 * `release()` is valid only while BOTH the values and the baseline are
 * what they were at release time: a later edit, or the canonical baseline
 * moving (a refetch, the saved server response), retires it for good — so
 * a released snapshot can never become a second, forever-clean baseline.
 * Inline forms that stay open after a save therefore adopt the server's
 * saved values into their fields (the baseline catches up) rather than
 * relying on the release.
 */
export function useUnsavedChanges<T>({
  label,
  values,
  baseline,
  active = true,
}: {
  label: string;
  values: T;
  baseline: T;
  active?: boolean;
}): UnsavedGuard<T> {
  const api = useContext(UnsavedChangesContext);
  if (api === null) {
    throw new Error(
      'useUnsavedChanges must be used inside <UnsavedChangesProvider>',
    );
  }
  const state = useRef({ label, values, baseline, active });
  const released = useRef<{ values: T; baseline: T } | null>(null);
  const [, rerender] = useState(0);

  const isReleased = (s: { values: T; baseline: T }): boolean =>
    released.current !== null &&
    sameValues(s.values, released.current.values) &&
    sameValues(s.baseline, released.current.baseline);

  const compute = (s: { values: T; baseline: T; active: boolean }): boolean =>
    s.active && !sameValues(s.values, s.baseline) && !isReleased(s);

  // Getters read the last COMMITTED render (handlers run after commit); a
  // release that no longer matches is retired here, never revived.
  useLayoutEffect(() => {
    state.current = { label, values, baseline, active };
    if (released.current !== null && !isReleased(state.current)) {
      released.current = null;
    }
  });

  const entry = useMemo<UnsavedEntry>(
    () => ({
      get label() {
        return state.current.label;
      },
      isDirty: () => compute(state.current),
      release: () => {
        released.current = {
          values: state.current.values,
          baseline: state.current.baseline,
        };
        rerender((n) => n + 1);
      },
    }),
    // compute() closes over refs only.
    [],
  );

  // Registered for the whole mount, in a LAYOUT effect: the registry holds
  // live getters, so it is complete before any later event can navigate,
  // whether or not this form is dirty yet.
  useLayoutEffect(() => api.register(entry), [api, entry]);

  const dirty = compute({ values, baseline, active });

  return useMemo<UnsavedGuard<T>>(
    () => ({
      dirty,
      isDirty: entry.isDirty,
      release: (v?: T) => {
        entry.release();
        if (v !== undefined && released.current !== null) {
          released.current = { ...released.current, values: v };
        }
      },
      confirmDiscard: async () => {
        if (!entry.isDirty()) return true;
        const ok = await api.confirmDiscard([state.current.label]);
        if (ok) entry.release();
        return ok;
      },
    }),
    [dirty, entry, api],
  );
}

/** Explicit leave actions outside the router (sign-out): refused while an
 *  operation is in flight; ask first when any form is dirty. */
export function useConfirmLeave(): (fn: () => void) => void {
  const api = useContext(UnsavedChangesContext);
  if (api === null) {
    throw new Error(
      'useConfirmLeave must be used inside <UnsavedChangesProvider>',
    );
  }
  return api.confirmLeave;
}

/** The provider API for lib/pendingOperation (same registry, same single
 *  route blocker). Throws outside the provider — no silent fallback. */
export function useLeaveGuardApi(): UnsavedChangesApi {
  const api = useContext(UnsavedChangesContext);
  if (api === null) {
    throw new Error(
      'usePendingOperation must be used inside <UnsavedChangesProvider>',
    );
  }
  return api;
}
