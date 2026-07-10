import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';
import { UnauthorizedError } from '../auth';

/**
 * Central QueryClient. Any 401 (UnauthorizedError from apiFetch) anywhere —
 * query or mutation — funnels into onUnauthorized so the shell can drop to
 * the TokenGate immediately. This wiring is correctly built and verified
 * end-to-end in Root.tsx. As of Plan 06 every screen's data-fetching routes
 * through useQuery/useMutation on this QueryClient (the last plain
 * `apiFetch`-based views died with the old tabbed Settings shell in Task 12).
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
