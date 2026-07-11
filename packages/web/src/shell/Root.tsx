import { QueryClientProvider } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { clearToken, getToken } from '../auth';
import { TokenGate } from '../components/TokenGate';
import { createQueryClient } from '../lib/queryClient';
import { AppToaster } from '../ui/toast';
import { AppLayout } from './AppLayout';

/** Token gate + query provider + shell. Any 401 anywhere funnels here. */
export function Root() {
  const [hasToken, setHasToken] = useState(getToken() !== null);
  const onUnauthorized = useCallback(() => {
    clearToken();
    setHasToken(false);
  }, []);
  const [client] = useState(() => createQueryClient(onUnauthorized));

  if (!hasToken) return <TokenGate onSaved={() => setHasToken(true)} />;

  return (
    <QueryClientProvider client={client}>
      <AppLayout onSignOut={onUnauthorized} />
      <AppToaster />
    </QueryClientProvider>
  );
}
