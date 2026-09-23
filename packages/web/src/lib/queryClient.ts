import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';
import { SessionChangedError, UnauthorizedError } from '../auth';

/**
 * Central QueryClient — one per authenticated session (Root creates a fresh
 * one on every sign-in, issue #251), so a query or mutation of an ended
 * session can never write into the next session's cache. Any 401
 * (UnauthorizedError from apiFetch) — query or mutation — funnels into
 * onUnauthorized, which signs out only while that 401's session is still
 * the current one (auth.isCurrentUnauthorized). A request whose session
 * ended in flight (SessionChangedError) is never retried under the newer
 * token.
 */
export function createQueryClient(
  onUnauthorized: (error: UnauthorizedError) => void,
): QueryClient {
  const handle = (error: unknown) => {
    if (error instanceof UnauthorizedError) onUnauthorized(error);
  };
  const noRetry = (error: unknown) =>
    error instanceof UnauthorizedError || error instanceof SessionChangedError;
  return new QueryClient({
    queryCache: new QueryCache({ onError: handle }),
    mutationCache: new MutationCache({ onError: handle }),
    defaultOptions: {
      queries: {
        retry: (failureCount, error) => !noRetry(error) && failureCount < 1,
        retryDelay: 0,
        staleTime: 15_000,
        refetchOnWindowFocus: true,
      },
      mutations: { retry: false },
    },
  });
}
