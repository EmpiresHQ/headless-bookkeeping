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
import { ConfirmDialog } from '../ui/ConfirmDialog';

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
 * Out of scope here (issue #251): a save still in flight when the operator
 * confirms leaving is not cancelled, and its completion may still act.
 */

export interface UnsavedEntry {
  label: string;
  isDirty: () => boolean;
  release: () => void;
}

interface UnsavedChangesApi {
  register: (entry: UnsavedEntry) => () => void;
  dirtyEntries: () => UnsavedEntry[];
  confirmDiscard: (labels: string[]) => Promise<boolean>;
  /** Run `fn` now if nothing is dirty; else after the operator confirms
   *  discarding every dirty form (which are then released). */
  confirmLeave: (fn: () => void) => void;
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

export function UnsavedChangesProvider({ children }: { children: ReactNode }) {
  const entries = useRef(new Set<UnsavedEntry>());
  const [registered, setRegistered] = useState(0);
  const pendingRef = useRef<{
    labels: string[];
    resolve: (ok: boolean) => void;
  } | null>(null);
  const [pending, setPending] = useState<string[] | null>(null);
  const [routeEpoch, setRouteEpoch] = useState(0);
  const bumpRouteEpoch = useCallback(() => setRouteEpoch((n) => n + 1), []);

  const settle = useCallback((ok: boolean) => {
    const p = pendingRef.current;
    pendingRef.current = null;
    setPending(null);
    p?.resolve(ok);
  }, []);

  const api = useMemo<UnsavedChangesApi>(() => {
    const dirtyEntries = () => [...entries.current].filter((e) => e.isDirty());
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
        setRegistered(entries.current.size);
        return () => {
          entries.current.delete(entry);
          setRegistered(entries.current.size);
        };
      },
      dirtyEntries,
      confirmDiscard,
      confirmLeave: (fn) => {
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
  }, []);

  // Unmount (sign-out, forced 401): answer any open question "keep" so no
  // caller's continuation runs later. Registered forms unregister
  // themselves (their own cleanup), so the registry is not touched here —
  // that also keeps StrictMode's effect replay from dropping live entries.
  useEffect(
    () => () => {
      pendingRef.current?.resolve(false);
      pendingRef.current = null;
    },
    [],
  );

  // Refresh / tab close / external navigation: the browser's own standard
  // confirmation. Attached only while some guarded form is mounted; the
  // handler re-reads the live getters, so it prompts only while something
  // is dirty and a synchronous release() counts immediately.
  useEffect(() => {
    if (registered === 0) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (api.dirtyEntries().length === 0) return;
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
      <RouteDiscardEpochContext.Provider value={routeEpoch}>
        {children}
      </RouteDiscardEpochContext.Provider>
      {dataRouter !== null && (
        <RouteLeaveGuard api={api} onDiscarded={bumpRouteEpoch} />
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
    </UnsavedChangesContext.Provider>
  );
}

/** The app's single router blocker (react-router allows one). Blocks a
 *  PATHNAME change — push, replace, Back/forward, a same-screen move to
 *  another object id — while any registered form is dirty. Search-only
 *  changes (?seg=, filters) never unmount a form and are not blocked.
 *
 *  A confirmed discard must really discard. The navigation that follows runs
 *  in a React transition: while the target's lazy chunk (or a suspending
 *  screen) loads, React keeps the OLD screen — the discarded form instance —
 *  on display, and a quick reversal (Back → Forward) would land on it again
 *  with its values intact but released as clean. So a discard first bumps
 *  the routed subtree's epoch (`onDiscarded`): an URGENT update that commits
 *  at once on the still-current location and remounts the screen from its
 *  baseline, before the transition to the next route is even started. */
function RouteLeaveGuard({
  api,
  onDiscarded,
}: {
  api: UnsavedChangesApi;
  onDiscarded: () => void;
}) {
  const dataRouter = useContext(UNSAFE_DataRouterContext);
  const blocker = useBlocker(
    useCallback<BlockerFunction>(
      ({ currentLocation, nextLocation }) =>
        currentLocation.pathname !== nextLocation.pathname &&
        api.dirtyEntries().length > 0,
      [api],
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
    const answer = (ok: boolean) => {
      if (!stillAsked()) return;
      if (ok) asked.proceed();
      else asked.reset();
    };
    const dirty = api.dirtyEntries();
    if (dirty.length === 0) {
      answer(true);
      return;
    }
    let live = true;
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
    return () => {
      live = false;
    };
    // `blocker` changes identity exactly when its state does.
  }, [blocker, api, onDiscarded, dataRouter]);

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

/** Explicit leave actions outside the router (sign-out): ask first when any
 *  form is dirty. */
export function useConfirmLeave(): (fn: () => void) => void {
  const api = useContext(UnsavedChangesContext);
  if (api === null) {
    throw new Error(
      'useConfirmLeave must be used inside <UnsavedChangesProvider>',
    );
  }
  return api.confirmLeave;
}
