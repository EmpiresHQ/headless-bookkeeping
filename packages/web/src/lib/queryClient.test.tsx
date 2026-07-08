import { describe, expect, it, vi } from 'vitest';
import { UnauthorizedError } from '../auth';
import { createQueryClient } from './queryClient';

describe('createQueryClient', () => {
  it('calls onUnauthorized when a query throws UnauthorizedError', async () => {
    const onUnauthorized = vi.fn();
    const client = createQueryClient(onUnauthorized);
    await client
      .fetchQuery({
        queryKey: ['boom'],
        queryFn: () => Promise.reject(new UnauthorizedError()),
      })
      .catch(() => undefined);
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it('does not retry unauthorized errors but retries others once', async () => {
    const client = createQueryClient(vi.fn());
    const fn = vi.fn(() => Promise.reject(new Error('flaky')));
    await client
      .fetchQuery({ queryKey: ['flaky'], queryFn: fn })
      .catch(() => undefined);
    expect(fn).toHaveBeenCalledTimes(2); // initial + 1 retry

    const fn401 = vi.fn(() => Promise.reject(new UnauthorizedError()));
    await client
      .fetchQuery({ queryKey: ['auth'], queryFn: fn401 })
      .catch(() => undefined);
    expect(fn401).toHaveBeenCalledTimes(1); // no retry on 401
  });
});
