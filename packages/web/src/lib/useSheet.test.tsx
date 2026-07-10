import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useSheet } from './useSheet';

describe('useSheet', () => {
  it('bumps the epoch on every open and retains the payload through close', () => {
    const { result } = renderHook(() => useSheet<number>());
    expect(result.current.isOpen).toBe(false);
    expect(result.current.payload).toBeNull();

    act(() => result.current.open(7));
    expect(result.current.isOpen).toBe(true);
    expect(result.current.epoch).toBe(1);
    expect(result.current.payload).toBe(7);

    act(() => result.current.close());
    expect(result.current.isOpen).toBe(false);
    // Retained — the exit animation renders the object it opened with.
    expect(result.current.payload).toBe(7);
    expect(result.current.epoch).toBe(1);

    act(() => result.current.open(9));
    expect(result.current.epoch).toBe(2); // remount-on-open key
    expect(result.current.payload).toBe(9);
  });

  it('close() is a no-op while already closed (StrictMode-safe identity)', () => {
    const { result } = renderHook(() => useSheet());
    act(() => result.current.close());
    expect(result.current.epoch).toBe(0);
    act(() => result.current.open());
    expect(result.current.isOpen).toBe(true);
    expect(result.current.payload).toBeNull();
  });
});
