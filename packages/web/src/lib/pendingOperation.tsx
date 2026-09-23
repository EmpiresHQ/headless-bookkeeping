import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  SessionChangedError,
  UnauthorizedError,
  isSameSession,
  sessionStamp,
} from '../auth';
import { toastErr } from '../ui/toast';
import { useLeaveGuardApi, type PendingEntry } from './unsavedChanges';

/**
 * Pending-operation contract (issue #251): PROTECTED WAITING.
 *
 * A mutation the operator started is waited for where it was started. While
 * it is in flight:
 * - a second start is a no-op — synchronously (a ref), so a same-tick
 *   double click / Enter sends exactly one request;
 * - every in-app exit is refused: the host Sheet (`busy`) refuses Escape /
 *   backdrop / swipe, the route blocker refuses links and Back/forward and
 *   sign-out is refused — both with a protected-wait status — and a page
 *   refresh/close gets the browser's prompt, even for a clean form;
 * - the form's fields are locked (PendingFieldset), so what was submitted
 *   is what the continuation releases.
 *
 * The continuation runs only while its SCOPE is live: this component still
 * mounted, the authenticated shell still mounted, and the same session
 * (auth revision + token) the operation started under. `perform` does every
 * await — API stages, cache invalidation — and may call `ctx.check()`
 * between stages; `onSuccess` / `onError` are SYNCHRONOUS UI continuations
 * (close, navigate, toast) run after one final liveness check. A stale
 * operation's outcome is dropped whole: no navigation, toast or setState.
 *
 * Order at completion: the pending registration is released FIRST (so the
 * operation's own close/navigation is not blocked by itself), the
 * continuation runs, and only then is the duplicate-start lock released.
 *
 * 401s: a current UnauthorizedError always reaches the shell's sign-out
 * (Root ignores it if a newer session exists) — the stale-scope check must
 * not swallow it, since that very 401 is what ended the scope. A
 * SessionChangedError (the request outlived its session) is dropped.
 *
 * Client guarantees only: a request the server has accepted stays
 * accepted — the client cannot abort it and never replays it. A forced tab
 * kill or reload mid-request leaves its outcome unknown to the UI.
 */

export interface OperationContext {
  /** Still the same component, shell and session? */
  live: () => boolean;
  /** Throw (silently ends the operation) unless live — call between stages
   *  that are not plain API requests (which check ownership themselves). */
  check: () => void;
}

/** A client-composed chain's stage boundary: throws to stop the chain
 *  before its next stage (`ctx.check`, or auth's session guard). */
export type StageGuard = () => void;

export interface OperationHandlers<T> {
  /** Synchronous UI continuation on success (live scope only). */
  onSuccess: (result: T) => void;
  /** Synchronous UI continuation on failure (live scope only). Defaults to
   *  an error toast. Input is untouched, so a deliberate retry works. */
  onError?: (error: unknown) => void;
}

export interface PendingOperation {
  /** Render flag: disable/lock the form and show progress. */
  pending: boolean;
  /** Start `perform` unless one is already in flight (returns false). */
  run: <T>(
    perform: (ctx: OperationContext) => Promise<T>,
    handlers: OperationHandlers<T>,
  ) => boolean;
}

/** Thrown by ctx.check() on a stale scope. */
class StaleOperation extends Error {}

/** For catches that deliberately CONTINUE a chain (best-effort stages,
 *  partial-success bookkeeping): an ended session or scope is never
 *  swallowed there — it must end the operation, not start the next stage. */
export function rethrowIfEnded(e: unknown): void {
  if (
    e instanceof SessionChangedError ||
    e instanceof UnauthorizedError ||
    e instanceof StaleOperation
  ) {
    throw e;
  }
}

/** A 401 anywhere in the cause chain (a helper that wraps its stage
 *  errors must still let the shell sign out). */
function findUnauthorized(e: unknown): UnauthorizedError | null {
  for (let cur = e, depth = 0; cur != null && depth < 5; depth += 1) {
    if (cur instanceof UnauthorizedError) return cur;
    cur =
      typeof cur === 'object' && 'cause' in cur
        ? (cur as { cause?: unknown }).cause
        : null;
  }
  return null;
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function usePendingOperation(label: string): PendingOperation {
  const api = useLeaveGuardApi();
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const mounted = useRef(false);
  const entry = useRef<PendingEntry>({ label });
  entry.current.label = label;

  // Layout effect: an unmount invalidates the scope synchronously in the
  // commit that removes the DOM — no window for a completion in between.
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = useCallback<PendingOperation['run']>(
    (perform, handlers) => {
      if (inFlight.current) return false;
      inFlight.current = true;
      const stamp = sessionStamp();
      // A fresh registration object per run: releasing it twice is a no-op.
      const release = api.registerPending({ ...entry.current });
      setPending(true);
      const live = () =>
        mounted.current && api.isAlive() && isSameSession(stamp);
      const ctx: OperationContext = {
        live,
        check: () => {
          if (!live()) throw new StaleOperation();
        },
      };
      void (async () => {
        let outcome:
          | { ok: true; value: unknown }
          | { ok: false; error: unknown };
        try {
          outcome = { ok: true, value: await perform(ctx) };
        } catch (error) {
          outcome = { ok: false, error };
        }
        release();
        try {
          const unauthorized = outcome.ok
            ? null
            : findUnauthorized(outcome.error);
          if (unauthorized !== null) {
            api.onUnauthorized(unauthorized);
            return;
          }
          if (!live()) return;
          if (outcome.ok) {
            handlers.onSuccess(outcome.value as never);
          } else if (
            !(outcome.error instanceof SessionChangedError) &&
            !(outcome.error instanceof StaleOperation)
          ) {
            (handlers.onError ?? ((e) => toastErr(errorMessage(e))))(
              outcome.error,
            );
          }
        } finally {
          inFlight.current = false;
          if (mounted.current) setPending(false);
        }
      })();
      return true;
    },
    [api],
  );

  return useMemo(() => ({ pending, run }), [pending, run]);
}

/**
 * A session-owned chain that is NOT a screen operation — an Undo launched
 * from a toast, which may be clicked after its screen is gone (independent
 * by design, no protected wait). `useSessionTask()` returns a factory; call
 * it when the work is OFFERED (e.g. when the Undo toast is shown) to bind
 * the current session. Every stage and the terminal continuation run only
 * while that session and the authenticated shell are still live; a current
 * 401 reaches the shell's sign-out; an ended session is dropped silently.
 */
export type SessionTask = <T>(
  perform: (stage: StageGuard) => Promise<T>,
  handlers: OperationHandlers<T>,
) => void;

export function useSessionTask(): () => SessionTask {
  const api = useLeaveGuardApi();
  return useCallback(() => {
    const stamp = sessionStamp();
    const live = () => api.isAlive() && isSameSession(stamp);
    const stage: StageGuard = () => {
      if (!live()) throw new StaleOperation();
    };
    return (perform, handlers) => {
      void (async () => {
        try {
          stage();
          const value = await perform(stage);
          if (live()) handlers.onSuccess(value);
        } catch (error) {
          const unauthorized = findUnauthorized(error);
          if (unauthorized !== null) {
            api.onUnauthorized(unauthorized);
            return;
          }
          if (
            !live() ||
            error instanceof SessionChangedError ||
            error instanceof StaleOperation
          ) {
            return;
          }
          (handlers.onError ?? ((e) => toastErr(errorMessage(e))))(error);
        }
      })();
    };
  }, [api]);
}
