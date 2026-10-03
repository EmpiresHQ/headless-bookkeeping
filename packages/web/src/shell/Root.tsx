import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AUTH_EPOCH_KEY,
  SESSION_ID_KEY,
  TOKEN_KEY,
  clearToken,
  currentSessionId,
  endObservedSession,
  getToken,
  isCurrentUnauthorized,
  storedAuthEpoch,
  storedSessionId,
  type UnauthorizedError,
} from '../auth';
import {
  clearImportPointer,
  watchImportPointerSession,
} from '../bank/importResume';
import { clearResultLog } from '../lib/resultLog';
import { TokenGate, type GateReason } from '../components/TokenGate';
import { createQueryClient } from '../lib/queryClient';
import { AppToaster, dismissToasts, toastWait } from '../ui/toast';
import { AppLayout } from './AppLayout';

/** One sign-in's scope: its client, the key its shell is mounted under,
 *  and the stored sign-in it was opened for (token + non-secret id; the id
 *  is null only for a token adopted before any tab minted one). */
interface Session {
  readonly client: QueryClient;
  readonly key: number;
  readonly token: string;
  readonly id: string | null;
  /** auth.AUTH_EPOCH_KEY when it was opened. */
  readonly epoch: string | null;
}

/** Token gate + query provider + shell. Any 401 anywhere funnels here.
 *
 *  Every sign-in is a fresh session scope (issue #251): its own QueryClient
 *  and its own AppLayout (keyed), whose unmount ends every operation of the
 *  old one. An ended session's client is cleared once its shell is gone,
 *  so late completions have no cache anyone reads. A late 401 of an ENDED
 *  session never signs the new one out (auth.isCurrentUnauthorized).
 *
 *  Issue #285: the gate is told why it is showing, and a sign-in change
 *  made in another tab (storage event) is followed here — sign-out there
 *  returns this tab to the gate; a new sign-in there (a new token or just a
 *  new session id) replaces this tab's whole shell, so nothing of the
 *  previous sign-in stays on screen. Observing never writes storage. */
export function Root() {
  const signOutRef = useRef<(reason: GateReason) => void>(() => undefined);
  // Stable for the component's life: every client is created with it.
  const [onUnauthorized] = useState(() => (error: UnauthorizedError) => {
    if (isCurrentUnauthorized(error)) signOutRef.current('ended');
  });
  const keys = useRef(0);
  // `id` is read by the caller: this tab's own mount/sign-in may mint one
  // (currentSessionId — a token stored before ids existed gets it once,
  // here); adopting another tab's sign-in only reads (storedSessionId).
  const open = useRef(
    (token: string, id: string | null): Session => ({
      client: createQueryClient(onUnauthorized),
      key: (keys.current += 1),
      token,
      id,
      epoch: storedAuthEpoch(),
    }),
  ).current;
  const [session, setSession] = useState<Session | null>(() => {
    const token = getToken();
    return token !== null ? open(token, currentSessionId()) : null;
  });
  const [reason, setReason] = useState<GateReason>('first');
  const [storageEpoch, setStorageEpoch] = useState(0);
  const live = useRef(session);
  const retired = useRef<QueryClient[]>([]);
  // The session whose shell should say it replaced another tab's sign-in
  // — said once its own toaster has mounted (see the effect below).
  const announce = useRef<number | null>(null);

  const replace = useCallback((next: Session | null) => {
    if (live.current !== null) retired.current.push(live.current.client);
    live.current = next;
    setSession(next);
  }, []);

  /** This tab's session state that must not outlive the sign-in. */
  const dropSessionState = useCallback(() => {
    // An ended session's import is not resumed by the next sign-in (#254)…
    clearImportPointer();
    // …nor are its recorded operation results (#259) or receipts shown.
    clearResultLog();
    dismissToasts();
  }, []);

  const signOut = useCallback(
    (why: GateReason) => {
      clearToken();
      dropSessionState();
      setReason(why);
      replace(null);
    },
    [dropSessionState, replace],
  );
  signOutRef.current = signOut;
  const signOutExplicitly = useCallback(() => signOut('signed-out'), [signOut]);

  // Another tab's sign-in/sign-out voids this tab's import pointer (#254).
  useEffect(() => watchImportPointerSession(), []);

  // Another tab's sign-in/sign-out (#285). Compares what is stored now with
  // the sign-in this tab's shell was opened for; events that change
  // nothing (a repeated write, an unrelated key) are ignored.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (
        e.key !== null &&
        e.key !== TOKEN_KEY &&
        e.key !== SESSION_ID_KEY &&
        e.key !== AUTH_EPOCH_KEY
      ) {
        return;
      }
      const current = live.current;
      const token = getToken();
      const id = storedSessionId();
      if (current === null) {
        // At the gate, any sign-in change elsewhere voids a check in
        // flight here — even one that ends where it began (in and out
        // again before this event): the revision moves, the gate is told.
        endObservedSession();
        setStorageEpoch((n) => n + 1);
        // Signed in elsewhere: that sign-in is this browser's now.
        if (token !== null) replace(open(token, id));
        return;
      }
      // ANY other pair is another sign-in — including an id appearing for
      // a token adopted without one (a legacy mint costs one extra remount;
      // telling it apart from a real same-token sign-in is not safe).
      if (
        token === current.token &&
        id === current.id &&
        storedAuthEpoch() === current.epoch
      ) {
        return;
      }
      endObservedSession();
      dropSessionState();
      if (token === null) {
        setReason('elsewhere');
        replace(null);
        return;
      }
      const next = open(token, id);
      announce.current = next.key;
      replace(next);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [dropSessionState, open, replace]);

  // After the replaced shell has unmounted. Idempotent, so StrictMode's
  // effect replay never touches a live client.
  useEffect(() => {
    const ended = retired.current.filter((c) => c !== session?.client);
    retired.current = [];
    ended.forEach((c) => c.clear());
    // Children's effects ran first: the new session's toaster is listening.
    if (session !== null && announce.current === session.key) {
      announce.current = null;
      toastWait(
        'session-changed',
        'You signed in again in another tab. This tab now shows that sign-in.',
      );
    }
  }, [session]);

  if (session === null) {
    return (
      <TokenGate
        reason={reason}
        storageEpoch={storageEpoch}
        onSaved={() => {
          const token = getToken();
          if (token !== null) replace(open(token, currentSessionId()));
        }}
      />
    );
  }
  // The toaster belongs to the session too: a replaced sign-in's receipts
  // leave with its shell at once, not after their exit animation.
  return (
    <QueryClientProvider key={session.key} client={session.client}>
      <AppLayout
        onSignOut={signOutExplicitly}
        onUnauthorized={onUnauthorized}
      />
      <AppToaster />
    </QueryClientProvider>
  );
}
