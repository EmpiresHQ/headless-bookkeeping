import { describe, expect, it, vi } from 'vitest';
import { SessionChangedError, UnauthorizedError } from '../auth';
import { createQueryClient } from './queryClient';

describe('createQueryClient', () => {
  it('calls onUnauthorized when a query throws UnauthorizedError', async () => {
    const onUnauthorized = vi.fn();
    const client = createQueryClient(onUnauthorized);
    await client
      .fetchQuery({
        queryKey: ['boom'],
        queryFn: () => Promise.reject(new UnauthorizedError(0)),
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

    const fn401 = vi.fn(() => Promise.reject(new UnauthorizedError(0)));
    await client
      .fetchQuery({ queryKey: ['auth'], queryFn: fn401 })
      .catch(() => undefined);
    expect(fn401).toHaveBeenCalledTimes(1); // no retry on 401
  });
});

describe('createQueryClient session ownership (#251)', () => {
  it('never retries a request whose session ended (no replay under the new token)', async () => {
    const client = createQueryClient(vi.fn());
    const fn = vi.fn(() => Promise.reject(new SessionChangedError()));
    await client
      .fetchQuery({ queryKey: ['old'], queryFn: fn })
      .catch(() => undefined);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('hands every 401 to the shell with its ownership (Root decides)', async () => {
    const onUnauthorized = vi.fn();
    const client = createQueryClient(onUnauthorized);
    const err = new UnauthorizedError(7);
    await client
      .fetchQuery({ queryKey: ['x'], queryFn: () => Promise.reject(err) })
      .catch(() => undefined);
    expect(onUnauthorized).toHaveBeenCalledWith(err);
  });
});
