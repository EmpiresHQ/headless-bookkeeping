import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';
import { UnauthorizedError } from '../auth';

/**
 * Central QueryClient. Any 401 (UnauthorizedError from apiFetch) anywhere —
 * query or mutation — funnels into onUnauthorized so the shell can drop to
 * the TokenGate immediately (fixes the legacy per-screen 401 desync).
 */
export function createQueryClient(onUnauthorized: () => void): QueryClient {
  const handle = (error: unknown) => {
    if (error instanceof UnauthorizedError) onUnauthorized();
  };
  return new QueryClient({
    queryCache: new QueryCache({ onError: handle }),
    mutationCache: new MutationCache({ onError: handle }),
    defaultOptions: {
      queries: {
        retry: (failureCount, error) =>
          !(error instanceof UnauthorizedError) && failureCount < 1,
        retryDelay: 0,
        staleTime: 15_000,
        refetchOnWindowFocus: true,
      },
      mutations: { retry: false },
    },
  });
}
