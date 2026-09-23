import { act, render, screen } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SessionChangedError,
  UnauthorizedError,
  clearToken,
  setToken,
} from '../auth';
import { AppToaster } from '../ui/toast';
import {
  rethrowIfEnded,
  usePendingOperation,
  useSessionTask,
  type PendingOperation,
  type SessionTask,
} from './pendingOperation';
import { UnsavedChangesProvider, useConfirmLeave } from './unsavedChanges';

/** A deferred: settle it from the test. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

let captured: PendingOperation;
let confirmLeave: (fn: () => void) => void;
let captureTask: () => SessionTask;

function Harness() {
  captured = usePendingOperation('Test op');
  confirmLeave = useConfirmLeave();
  captureTask = useSessionTask();
  return <p>{captured.pending ? 'pending' : 'idle'}</p>;
}

function mount(onUnauthorized = vi.fn()) {
  const utils = render(
    <StrictMode>
      <UnsavedChangesProvider onUnauthorized={onUnauthorized}>
        <Harness />
        <AppToaster />
      </UnsavedChangesProvider>
    </StrictMode>,
  );
  return { ...utils, onUnauthorized };
}

describe('usePendingOperation (#251)', () => {
  beforeEach(() => {
    localStorage.clear();
    setToken('session-a');
  });
  afterEach(() => vi.restoreAllMocks());

  it('locks synchronously: a second run in the same tick is refused; retry after failure is allowed', async () => {
    mount();
    const d = deferred<number>();
    const perform = vi.fn(() => d.promise);
    const onError = vi.fn();
    let first = false;
    let second = true;
    act(() => {
      // Same act, same captured object — no rerender in between.
      first = captured.run(perform, { onSuccess: vi.fn(), onError });
      second = captured.run(perform, { onSuccess: vi.fn(), onError });
    });
    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(perform).toHaveBeenCalledTimes(1);
    expect(screen.getByText('pending')).toBeInTheDocument();

    await act(async () => d.reject(new Error('503 Service Unavailable')));
    expect(onError).toHaveBeenCalledTimes(1);
    expect(screen.getByText('idle')).toBeInTheDocument();

    const again = vi.fn(() => Promise.resolve(1));
    const onSuccess = vi.fn();
    let retried = false;
    act(() => {
      retried = captured.run(again, { onSuccess });
    });
    await flush();
    expect(retried).toBe(true);
    expect(onSuccess).toHaveBeenCalledWith(1);
  });

  it('releases protection BEFORE its own continuation, but keeps the duplicate lock until the continuation returns', async () => {
    mount();
    const seen: { leaveRan: boolean; rerun: boolean } = {
      leaveRan: false,
      rerun: true,
    };
    act(() => {
      captured.run(() => Promise.resolve('ok'), {
        onSuccess: () => {
          // Own "navigation": the leave guard no longer counts this op.
          confirmLeave(() => {
            seen.leaveRan = true;
          });
          // Still inside the continuation: a new start is refused.
          seen.rerun = captured.run(() => Promise.resolve('dup'), {
            onSuccess: vi.fn(),
          });
        },
      });
    });
    await flush();
    expect(seen).toEqual({ leaveRan: true, rerun: false });
  });

  it('refuses sign-out (confirmLeave) with a protected-wait status while in flight', async () => {
    mount();
    const d = deferred<void>();
    act(() => {
      captured.run(() => d.promise, { onSuccess: vi.fn() });
    });
    const leave = vi.fn();
    act(() => confirmLeave(leave));
    expect(leave).not.toHaveBeenCalled();
    expect(
      await screen.findByText(/“Test op” is still saving/),
    ).toBeInTheDocument();
    await act(async () => d.resolve());
    act(() => confirmLeave(leave));
    expect(leave).toHaveBeenCalledTimes(1);
  });

  it('drops a stale completion after the owner unmounts (no success, no error toast)', async () => {
    const { unmount } = mount();
    const d = deferred<void>();
    const onSuccess = vi.fn();
    const onError = vi.fn();
    act(() => {
      captured.run(() => d.promise, { onSuccess, onError });
    });
    unmount();
    await act(async () => d.resolve());
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it('drops a completion once the session changed (sign-in B while A was in flight), success or failure', async () => {
    mount();
    for (const settle of ['resolve', 'reject'] as const) {
      const d = deferred<void>();
      const onSuccess = vi.fn();
      const onError = vi.fn();
      act(() => {
        captured.run(() => d.promise, { onSuccess, onError });
      });
      clearToken();
      setToken(`session-${settle}`);
      await act(async () =>
        settle === 'resolve' ? d.resolve() : d.reject(new Error('late')),
      );
      expect(onSuccess).not.toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();
    }
  });

  it('ctx.check stops a chain at its next stage once the session changed', async () => {
    mount();
    const stage1 = deferred<void>();
    const stage2 = vi.fn(() => Promise.resolve());
    const onError = vi.fn();
    act(() => {
      captured.run(
        async (ctx) => {
          await stage1.promise;
          ctx.check();
          await stage2();
        },
        { onSuccess: vi.fn(), onError },
      );
    });
    localStorage.setItem('bk_api_token', 'other-tab-token'); // token replaced
    await act(async () => stage1.resolve());
    expect(stage2).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it('a CURRENT 401 reaches the shell even though it ended the scope; SessionChangedError is silent', async () => {
    const { onUnauthorized } = mount();
    const onError = vi.fn();
    act(() => {
      captured.run(
        async () => {
          clearToken(); // what apiFetch does on a current 401
          throw new UnauthorizedError(0);
        },
        { onSuccess: vi.fn(), onError },
      );
    });
    await flush();
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();

    setToken('session-b');
    act(() => {
      captured.run(() => Promise.reject(new SessionChangedError()), {
        onSuccess: vi.fn(),
        onError,
      });
    });
    await flush();
    expect(onError).not.toHaveBeenCalled();
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('routes a 401 wrapped as a cause (helper errors) to the shell', async () => {
    const { onUnauthorized } = mount();
    act(() => {
      captured.run(
        () =>
          Promise.reject(
            Object.assign(new Error('wrapped'), {
              cause: new UnauthorizedError(0),
            }),
          ),
        { onSuccess: vi.fn() },
      );
    });
    await flush();
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('rethrowIfEnded never lets a best-effort catch swallow an ended session', () => {
    expect(() => rethrowIfEnded(new SessionChangedError())).toThrow(
      SessionChangedError,
    );
    expect(() => rethrowIfEnded(new UnauthorizedError(0))).toThrow(
      UnauthorizedError,
    );
    expect(() => rethrowIfEnded(new Error('advisory'))).not.toThrow();
  });
});

describe('useSessionTask (Undo from a toast) (#251)', () => {
  beforeEach(() => {
    localStorage.clear();
    setToken('session-a');
  });

  it('runs its stages and terminal effect only in the session it was offered in', async () => {
    mount();
    const task = captureTask();
    clearToken();
    setToken('session-b');
    const perform = vi.fn(() => Promise.resolve());
    const onSuccess = vi.fn();
    const onError = vi.fn();
    act(() => task(perform, { onSuccess, onError }));
    await flush();
    expect(perform).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it('stops before a later stage and skips its terminal effect when the session ends mid-chain', async () => {
    mount();
    const task = captureTask();
    const first = deferred<void>();
    const second = vi.fn(() => Promise.resolve());
    const onSuccess = vi.fn();
    act(() =>
      task(
        async (stage) => {
          await first.promise;
          stage();
          await second();
        },
        { onSuccess },
      ),
    );
    clearToken();
    setToken('session-b');
    await act(async () => first.resolve());
    expect(second).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('sends a current 401 to the shell', async () => {
    const { onUnauthorized } = mount();
    const task = captureTask();
    act(() =>
      task(() => Promise.reject(new UnauthorizedError(0)), {
        onSuccess: vi.fn(),
      }),
    );
    await flush();
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });
});

describe('usePendingOperation outside the provider', () => {
  it('throws — there is no silent fallback that disables protection', () => {
    function Bare() {
      usePendingOperation('x');
      return null;
    }
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => render(<Bare />)).toThrow(/UnsavedChangesProvider/);
  });
});
