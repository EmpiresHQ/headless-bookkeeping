import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  clearToken,
  getToken,
  isCurrentUnauthorized,
  type UnauthorizedError,
} from '../auth';
import {
  clearImportPointer,
  watchImportPointerSession,
} from '../bank/importResume';
import { TokenGate } from '../components/TokenGate';
import { createQueryClient } from '../lib/queryClient';
import { AppToaster } from '../ui/toast';
import { AppLayout } from './AppLayout';

/** Token gate + query provider + shell. Any 401 anywhere funnels here.
 *
 *  Every sign-in is a fresh session scope (issue #251): its own QueryClient
 *  and its own AppLayout, whose unmount ends every operation of the old
 *  one. The ended session's client is cleared once the shell is gone, so
 *  late completions have no cache anyone reads. A late 401 of an ENDED
 *  session never signs the new one out (auth.isCurrentUnauthorized). */
export function Root() {
  const signOutRef = useRef<() => void>(() => undefined);
  // Stable for the component's life: every client is created with it.
  const [onUnauthorized] = useState(() => (error: UnauthorizedError) => {
    if (isCurrentUnauthorized(error)) signOutRef.current();
  });
  const [client, setClient] = useState<QueryClient | null>(() =>
    getToken() !== null ? createQueryClient(onUnauthorized) : null,
  );
  const live = useRef(client);
  // Another tab's sign-in/sign-out voids this tab's import pointer (#254).
  useEffect(() => watchImportPointerSession(), []);
  const retired = useRef<QueryClient | null>(null);

  const signOut = useCallback(() => {
    clearToken();
    // An ended session's import is not resumed by the next sign-in (#254).
    clearImportPointer();
    if (live.current !== null) retired.current = live.current;
    live.current = null;
    setClient(null);
  }, []);
  signOutRef.current = signOut;

  // After the shell has unmounted. Idempotent, so StrictMode's effect
  // replay never touches a live client.
  useEffect(() => {
    if (client !== null || retired.current === null) return;
    retired.current.clear();
    retired.current = null;
  }, [client]);

  if (client === null) {
    return (
      <TokenGate
        onSaved={() => {
          const next = createQueryClient(onUnauthorized);
          live.current = next;
          setClient(next);
        }}
      />
    );
  }
  return (
    <QueryClientProvider client={client}>
      <AppLayout onSignOut={signOut} onUnauthorized={onUnauthorized} />
      <AppToaster />
    </QueryClientProvider>
  );
}
