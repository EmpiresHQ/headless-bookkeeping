import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { openSignedDocument, PopupBlockedError } from '../api';
import { isSameSession, sessionStamp, SessionChangedError } from '../auth';
import { findUnauthorized } from '../lib/pendingOperation';
import { useLeaveGuardApi } from '../lib/unsavedChanges';

/** Where the preview's "Open original" stands (issue #272). */
export type OpenOriginalStatus =
  | { status: 'idle' }
  /** `retrying`: started from the failure's own retry button. */
  | { status: 'pending'; retrying: boolean }
  | { status: 'error' }
  | { status: 'blocked' };

export type OpenOriginalState = OpenOriginalStatus & {
  /** Open the original in a new tab. Call it straight from the click
   *  handler: the placeholder tab is opened synchronously, inside the
   *  gesture. No-op while an attempt is pending (single flight). */
  start: (opts?: { retrying?: boolean }) => void;
};

/**
 * "Open original" for the document preview of `documentId` while it is
 * `open`. An attempt belongs to that scope — this document, this opening of
 * the preview, this component and session: when the scope ends (another
 * document, the preview closed, unmount — which a sign-out is) its
 * placeholder tab is closed at once and its outcome is dropped — no state,
 * no focus; a session that moved on without unmounting is caught before
 * the placeholder is navigated. A current 401 goes to the shell's session handling (Root signs out
 * only while that 401's session is still live); an ended session is silent.
 * A failure or blocked popup is kept for the preview to show with a retry;
 * the current window is never navigated away.
 *
 * Not a protected wait (lib/pendingOperation): minting a link is a read, so
 * route leave and sign-out stay available — they simply end the scope.
 */
export function useOpenOriginal(
  documentId: number,
  open: boolean,
): OpenOriginalState {
  const api = useLeaveGuardApi();
  const [entry, setEntry] = useState<{
    id: number;
    state: OpenOriginalStatus;
  } | null>(null);
  const attempt = useRef<AbortController | null>(null);

  // The live scope, bound at commit: `start` only ever runs for it.
  const scope = useRef<{ id: number; open: boolean } | null>(null);

  // Scope end, at commit (a layout cleanup — not whenever passive effects
  // get flushed): whatever is in flight no longer owns anything, and a
  // reopen (or the next document) starts clean.
  useLayoutEffect(() => {
    scope.current = { id: documentId, open };
    if (!open) return;
    return () => {
      scope.current = null;
      // Closes a still-blank placeholder tab right away.
      attempt.current?.abort();
      attempt.current = null;
      setEntry(null);
    };
  }, [documentId, open]);

  const start = useCallback(
    ({ retrying = false }: { retrying?: boolean } = {}) => {
      const live = scope.current;
      if (
        attempt.current !== null ||
        live === null ||
        !live.open ||
        live.id !== documentId
      ) {
        return;
      }
      const mine = new AbortController();
      attempt.current = mine;
      const stamp = sessionStamp();
      const current = () => attempt.current === mine && isSameSession(stamp);
      // Another tab signing in or out ends this session without unmounting
      // anything here: close the placeholder then too, not only at the end.
      // The attempt is given up right away, so the new session's first
      // click never waits on this one's (possibly hanging) request.
      const onStorage = () => {
        if (isSameSession(stamp) || attempt.current !== mine) return;
        mine.abort();
        attempt.current = null;
        setEntry(null);
      };
      window.addEventListener('storage', onStorage);
      mine.signal.addEventListener('abort', () =>
        window.removeEventListener('storage', onStorage),
      );
      setEntry({ id: documentId, state: { status: 'pending', retrying } });
      // Synchronous up to window.open: still inside the user's gesture.
      const request = openSignedDocument(documentId, {
        signal: mine.signal,
        isCurrent: current,
      });
      const settle = (state: OpenOriginalStatus | null) => {
        window.removeEventListener('storage', onStorage);
        if (attempt.current !== mine) return;
        attempt.current = null;
        setEntry(state === null ? null : { id: documentId, state });
      };
      void Promise.resolve(request).then(
        () => settle({ status: 'idle' }),
        (e: unknown) => {
          const unauthorized = findUnauthorized(e);
          if (unauthorized !== null) {
            settle(null);
            api.onUnauthorized(unauthorized);
            return;
          }
          // An ended session's outcome is nobody's to show.
          if (e instanceof SessionChangedError || !current()) {
            settle(null);
            return;
          }
          settle(
            e instanceof PopupBlockedError
              ? { status: 'blocked' }
              : { status: 'error' },
          );
        },
      );
    },
    [api, documentId],
  );

  const state: OpenOriginalStatus =
    open && entry !== null && entry.id === documentId
      ? entry.state
      : { status: 'idle' };
  return { ...state, start };
}
