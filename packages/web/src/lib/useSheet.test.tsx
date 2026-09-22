import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { useSheet } from './useSheet';

const wrapper = ({ children }: { children: ReactNode }) => (
  <MemoryRouter initialEntries={['/books/expenses/1']}>{children}</MemoryRouter>
);

describe('useSheet', () => {
  it('bumps the epoch on every open and retains the payload through close', () => {
    const { result } = renderHook(() => useSheet<number>(), { wrapper });
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
    const { result } = renderHook(() => useSheet(), { wrapper });
    act(() => result.current.close());
    expect(result.current.epoch).toBe(0);
    act(() => result.current.open());
    expect(result.current.isOpen).toBe(true);
    expect(result.current.payload).toBeNull();
  });

  it('closes when the pathname changes under a still-mounted screen (#250)', () => {
    const { result } = renderHook(
      () => ({ sheet: useSheet(), navigate: useNavigate() }),
      { wrapper },
    );
    act(() => result.current.sheet.open());
    expect(result.current.sheet.isOpen).toBe(true);

    // A search-only change keeps it open…
    act(() => void result.current.navigate('/books/expenses/1?tab=x'));
    expect(result.current.sheet.isOpen).toBe(true);
    // …another object on the same screen closes it.
    act(() => void result.current.navigate('/books/expenses/2'));
    expect(result.current.sheet.isOpen).toBe(false);
    expect(result.current.sheet.epoch).toBe(1);
  });
});
