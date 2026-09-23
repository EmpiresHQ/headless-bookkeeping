import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BlockedReason,
  lookupBlocker,
  lookupState,
  LookupNotice,
  useEntityPick,
} from './Lookup';

const q = (over: Partial<Parameters<typeof lookupState>[0]>) => ({
  data: undefined,
  isError: false,
  error: null,
  refetch: vi.fn(),
  ...over,
});

describe('lookupState (#260)', () => {
  it('tells loading, failed, stale and fresh apart — only fresh empty is empty', () => {
    expect(lookupState(q({}))).toBe('loading');
    expect(lookupState(q({ isError: true, error: new Error('503') }))).toBe(
      'error',
    );
    expect(lookupState(q({ data: [], isError: true }))).toBe('stale');
    expect(lookupState(q({ data: [] }))).toBe('ready');
    expect(lookupBlocker(q({}), 'suppliers')).toMatch(/Waiting for suppliers/);
    expect(
      lookupBlocker(q({ isError: true, error: new Error('x') }), 'suppliers'),
    ).toMatch(/Couldn't load suppliers/);
    expect(lookupBlocker(q({ data: [], isError: true }), 'suppliers')).toBe(
      null,
    );
    expect(lookupBlocker(q({ data: [] }), 'suppliers')).toBe(null);
  });

  it('LookupNotice: reason + Retry for a failed load and a failed refresh; nothing when fresh', () => {
    const failed = q({ isError: true, error: new Error('HTTP 503') });
    const { rerender } = render(
      <LookupNotice query={failed} what="categories" />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(
      "Couldn't load categories (HTTP 503)",
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retry categories' }));
    expect(failed.refetch).toHaveBeenCalledTimes(1);

    rerender(
      <LookupNotice
        query={q({ data: [1], isError: true, error: new Error('HTTP 503') })}
        what="categories"
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(
      'showing the list loaded earlier',
    );

    rerender(<LookupNotice query={q({})} what="categories" />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading categories…');

    rerender(<LookupNotice query={q({ data: [] })} what="categories" />);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('BlockedReason states the reason only when there is one', () => {
    const { rerender, container } = render(<BlockedReason reason="Why" />);
    expect(container).toHaveTextContent('Why');
    rerender(<BlockedReason reason={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});

type E = { id: number; name: string };
const A: E = { id: 1, name: 'A' };
const NEW: E = { id: 9, name: 'Created' };

describe('useEntityPick (#260)', () => {
  afterEach(() => vi.restoreAllMocks());

  function setup(initial: { data: E[] | undefined; dataUpdatedAt: number }) {
    return renderHook((props) => useEntityPick(props), {
      initialProps: initial,
    });
  }

  it('a list pick is gone once a usable list lacks it (deleted / role changed)', () => {
    const h = setup({ data: [A], dataUpdatedAt: 100 });
    act(() => h.result.current.set(A));
    expect(h.result.current.gone).toBe(false);
    h.rerender({ data: [{ ...A, name: 'A renamed' }], dataUpdatedAt: 200 });
    // The list's current view of it is shown.
    expect(h.result.current.entity?.name).toBe('A renamed');
    h.rerender({ data: [], dataUpdatedAt: 300 });
    expect(h.result.current.gone).toBe(true);
    // Still shown (never silently dropped) — as last known.
    expect(h.result.current.entity?.id).toBe(1);
  });

  it('a created entity is trusted over an older cached list, but a later successful list without it blocks', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const h = setup({ data: [A], dataUpdatedAt: 900 });
    act(() => h.result.current.set(NEW, { created: true }));
    // The cached list predates the creation: its omission proves nothing.
    expect(h.result.current.gone).toBe(false);
    expect(h.result.current.entity).toEqual(NEW);
    // A failed refetch keeps the old list and its timestamp — still usable.
    h.rerender({ data: [A], dataUpdatedAt: 900 });
    expect(h.result.current.gone).toBe(false);
    // A successful response AFTER the creation that lacks it: gone, even
    // though it was never seen in any list.
    h.rerender({ data: [], dataUpdatedAt: 1_500 });
    expect(h.result.current.gone).toBe(true);
  });

  it('a created entity seen in a later list, then removed, is gone', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const h = setup({ data: [A], dataUpdatedAt: 900 });
    act(() => h.result.current.set(NEW, { created: true }));
    h.rerender({ data: [A, NEW], dataUpdatedAt: 1_200 });
    expect(h.result.current.gone).toBe(false);
    h.rerender({ data: [A], dataUpdatedAt: 1_300 });
    expect(h.result.current.gone).toBe(true);
    act(() => h.result.current.set(null));
    expect(h.result.current.gone).toBe(false);
    expect(h.result.current.entity).toBe(null);
  });
});
