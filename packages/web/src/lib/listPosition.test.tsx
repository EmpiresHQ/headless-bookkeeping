import { act, fireEvent, render, screen } from '@testing-library/react';
import { useRef, useSyncExternalStore } from 'react';
import {
  Link,
  RouterProvider,
  createBrowserRouter,
  useSearchParams,
} from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setToken } from '../auth';
import { LoadError } from '../ui/LoadError';
import {
  POSITION_ROW,
  resetListPositions,
  useReturnPosition,
} from './listPosition';

/**
 * Issue #283 — a list returns to the row it was left from, on the exact
 * history entry (jsdom's History + popstate through createBrowserRouter).
 * Layout is simulated: row i sits at page y = 100 + 60·i, the page scrolls
 * via window.scrollTo.
 */

const ROWS = 50;
const ROW_H = 60;
let scrollY = 0;
// Extra height above every row — late names/markers growing the rows.
let growth = 0;
const pageTop = (i: number) => 100 + (ROW_H + growth) * i;

// jsdom has no ResizeObserver: a controllable one (`relayout()` fires it).
const observers = new Set<ResizeObserverCallback>();
class FakeResizeObserver {
  constructor(private cb: ResizeObserverCallback) {}
  observe() {
    observers.add(this.cb);
  }
  unobserve() {}
  disconnect() {
    observers.delete(this.cb);
  }
}
const relayout = (extra: number) => {
  growth = extra;
  act(() => observers.forEach((cb) => cb([], {} as ResizeObserver)));
};

// The list's readiness (its query), switchable mid-test.
let ready = true;
const listeners = new Set<() => void>();
const setReady = (v: boolean) => {
  ready = v;
  listeners.forEach((l) => l());
};
const useReady = () =>
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => ready,
  );

function List() {
  const rootRef = useRef<HTMLDivElement>(null);
  const isReady = useReady();
  const [params, setParams] = useSearchParams();
  useReturnPosition(rootRef, isReady);
  return (
    <div ref={rootRef}>
      <input
        aria-label="Search"
        value={params.get('q') ?? ''}
        onChange={(e) => setParams({ q: e.target.value }, { replace: true })}
      />
      <Link to="/item/elsewhere">Elsewhere</Link>
      {isReady ? (
        Array.from({ length: ROWS }, (_, i) => (
          <Link
            key={i}
            to={`/item/${i}`}
            data-i={i}
            {...{ [POSITION_ROW]: '' }}
          >
            row {i}
          </Link>
        ))
      ) : (
        <LoadError message="Failed" onRetry={() => setReady(true)} />
      )}
    </div>
  );
}

function Detail() {
  return <Link to="/list">Fresh list</Link>;
}

// The phone tab bar's top edge (a fixed bar; hidden on desktop).
const tabBarTop = 700;

let router: ReturnType<typeof createBrowserRouter>;
function mount() {
  router = createBrowserRouter([
    { path: '/list', element: <List /> },
    { path: '/item/:id', element: <Detail /> },
  ]);
  return render(<RouterProvider router={router} />);
}

const row = (i: number) => screen.getByText(`row ${i}`);
const scrollTo = (y: number) => {
  scrollY = y;
};
async function back() {
  await act(async () => {
    window.history.back();
    await new Promise((r) => setTimeout(r, 30));
  });
}
async function forward() {
  await act(async () => {
    window.history.forward();
    await new Promise((r) => setTimeout(r, 30));
  });
}

/* The browser's own history scroll restoration: each entry keeps the
 * offset it was left at, and a traversal restores the target entry's
 * offset right after `popstate` (queued behind the event's listeners) —
 * while the list it leaves is still mounted. */
const savedOffsets = new Map<string, number>();
const historyKey = () =>
  (window.history.state as { key?: string } | null)?.key ?? 'default';
function restoreNatively() {
  let current = historyKey();
  const push = window.history.pushState.bind(window.history);
  vi.spyOn(window.history, 'pushState').mockImplementation((...args) => {
    savedOffsets.set(current, scrollY);
    push(...args);
    current = historyKey();
  });
  const onPop = () => {
    savedOffsets.set(current, scrollY);
    current = historyKey();
    const y = savedOffsets.get(current) ?? 0;
    queueMicrotask(() => scrollTo(y));
  };
  window.addEventListener('popstate', onPop);
  return () => window.removeEventListener('popstate', onPop);
}

async function openRow(i: number, init: MouseEventInit = {}) {
  await act(async () => {
    fireEvent.click(row(i), { button: 0, ...init });
  });
}

beforeEach(() => {
  resetListPositions();
  setToken('token-a');
  ready = true;
  scrollY = 0;
  growth = 0;
  observers.clear();
  savedOffsets.clear();
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  window.history.replaceState(null, '', '/list');
  Object.defineProperty(window, 'scrollY', {
    configurable: true,
    get: () => scrollY,
  });
  vi.spyOn(window, 'scrollTo').mockImplementation(((
    x: number | ScrollToOptions,
    y?: number,
  ) => {
    scrollTo(typeof x === 'number' ? (y ?? 0) : (x.top ?? 0));
  }) as typeof window.scrollTo);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    function (this: HTMLElement) {
      if (this.hasAttribute('data-tabbar'))
        return new DOMRect(0, tabBarTop, 300, 68);
      const i = Number(this.dataset.i);
      if (!this.isConnected || Number.isNaN(i)) return new DOMRect(0, 0, 0, 0);
      return new DOMRect(0, pageTop(i) - scrollY, 300, ROW_H);
    },
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('list return position (issue #283)', () => {
  it('Back from an opened row lands on that row, at its height, focused', async () => {
    mount();
    scrollTo(pageTop(12) - 300); // row 12 at 300px in the viewport
    await openRow(12);
    expect(window.location.pathname).toBe('/item/12');
    scrollTo(0); // the detail screen starts at its top
    await back();
    expect(window.location.pathname).toBe('/list');
    expect(row(12).getBoundingClientRect().top).toBe(300);
    expect(document.activeElement).toBe(row(12));
  });

  it('a search REPLACE re-keys the entry: its last key still returns', async () => {
    mount();
    fireEvent.change(screen.getByLabelText('Search'), {
      target: { value: 'D' },
    });
    fireEvent.change(screen.getByLabelText('Search'), {
      target: { value: 'DE' },
    });
    scrollTo(pageTop(20) - 200);
    await openRow(20);
    scrollTo(0);
    await back();
    expect(window.location.search).toBe('?q=DE');
    expect(row(20).getBoundingClientRect().top).toBe(200);
  });

  it('a new entry with the same pathname does not inherit the position', async () => {
    mount();
    scrollTo(pageTop(12) - 300);
    await openRow(12);
    scrollTo(0);
    await act(async () => {
      fireEvent.click(screen.getByText('Fresh list'));
    });
    expect(window.location.pathname).toBe('/list');
    expect(window.scrollY).toBe(0);
    expect(document.activeElement).not.toBe(row(12));
  });

  it('another session never restores this one’s position', async () => {
    mount();
    scrollTo(pageTop(12) - 300);
    await openRow(12);
    setToken('token-b');
    scrollTo(0);
    await back();
    expect(window.scrollY).toBe(0);
  });

  it('a Ctrl/Meta click records no opened row', async () => {
    mount();
    scrollTo(pageTop(12) - 300);
    // Modified click: react-router leaves it to the browser (new tab) —
    // stood in for here, since jsdom cannot open one.
    const newTab = (e: MouseEvent) => {
      if (e.ctrlKey || e.metaKey) e.preventDefault();
    };
    window.addEventListener('click', newTab);
    await openRow(12, { ctrlKey: true });
    await openRow(12, { metaKey: true });
    window.removeEventListener('click', newTab);
    expect(window.location.pathname).toBe('/list');
    // Leave by a non-row navigation at the same scroll position.
    const y = window.scrollY;
    await act(async () => {
      fireEvent.click(screen.getByText('Elsewhere'), { button: 0 });
    });
    expect(window.location.pathname).toBe('/item/elsewhere');
    scrollTo(0);
    await back();
    // The page position returns (topmost visible row) — but no row was
    // opened here, so none takes focus.
    expect(window.scrollY).toBe(y);
    expect(document.activeElement).not.toBe(row(12));
    expect(document.activeElement).toBe(document.body);
  });

  it('a sign-in change while the list is shown: its position is not handed on', async () => {
    mount();
    scrollTo(pageTop(12) - 300);
    setToken('token-b'); // before the list unmounts
    await openRow(12);
    scrollTo(0);
    await back();
    expect(window.scrollY).toBe(0);
    expect(document.activeElement).not.toBe(row(12));
  });

  it('waits for the rows; a failed refetch and Retry return to the row again', async () => {
    mount();
    scrollTo(pageTop(12) - 300);
    await openRow(12);
    scrollTo(0);
    await back();
    expect(row(12).getBoundingClientRect().top).toBe(300);
    // The stale refetch fails: the rows give way to LoadError.
    act(() => setReady(false));
    scrollTo(0); // the page collapsed to its top
    const retry = screen.getByRole('button', { name: 'Retry' });
    // A primary press (jsdom's fireEvent.pointerDown carries no `button`).
    retry.dispatchEvent(
      new MouseEvent('pointerdown', { bubbles: true, button: 0 }),
    );
    await act(async () => {
      fireEvent.click(retry);
    });
    expect(row(12).getBoundingClientRect().top).toBe(300);
  });

  it('user intent while the rows are away cancels the return', async () => {
    mount();
    scrollTo(pageTop(12) - 300);
    await openRow(12);
    scrollTo(0);
    ready = false; // arrives without rows (loading)
    await back();
    fireEvent.wheel(window);
    scrollTo(40);
    act(() => setReady(true));
    expect(window.scrollY).toBe(40);
  });

  it('late layout keeps re-anchoring with no timeout, until intent', async () => {
    vi.useFakeTimers({ toFake: ['performance', 'Date'] });
    try {
      mount();
      scrollTo(pageTop(12) - 300);
      await openRow(12);
      scrollTo(0);
      await back();
      expect(row(12).getBoundingClientRect().top).toBe(300);
      // Names arrive long after any "settle" window: rows grow above it.
      vi.advanceTimersByTime(30_000);
      relayout(353);
      expect(row(12).getBoundingClientRect().top).toBe(300);
      // The user scrolls: later layout no longer moves the page.
      fireEvent.wheel(window);
      scrollTo(scrollY + 100);
      relayout(400);
      expect(row(12).getBoundingClientRect().top).not.toBe(300);
    } finally {
      vi.useRealTimers();
    }
  });

  it('scrolling over Retry is still intent; only activating it is not', async () => {
    mount();
    scrollTo(pageTop(12) - 300);
    await openRow(12);
    scrollTo(0);
    await back();
    act(() => setReady(false));
    scrollTo(0);
    const retry = screen.getByRole('button', { name: 'Retry' });
    fireEvent.wheel(retry);
    scrollTo(20);
    await act(async () => {
      fireEvent.click(retry);
    });
    expect(window.scrollY).toBe(20);
  });

  it('a scroll key on a focused Retry is intent; Enter is activation', async () => {
    mount();
    scrollTo(pageTop(12) - 300);
    await openRow(12);
    scrollTo(0);
    await back();
    act(() => setReady(false));
    const retry = screen.getByRole('button', { name: 'Retry' });
    fireEvent.keyDown(retry, { key: 'Enter' });
    await act(async () => {
      fireEvent.click(retry);
    });
    expect(row(12).getBoundingClientRect().top).toBe(300);
    act(() => setReady(false));
    scrollTo(0);
    fireEvent.keyDown(screen.getByRole('button', { name: 'Retry' }), {
      key: 'PageDown',
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    });
    expect(window.scrollY).toBe(0);
  });

  it('the opened row returns above the phone tab bar (desktop → phone)', async () => {
    const bar = document.createElement('nav');
    bar.setAttribute('data-tabbar', '');
    document.body.append(bar);
    try {
      mount();
      // Opened near the bottom of a tall desktop viewport…
      scrollTo(pageTop(12) - 740);
      await openRow(12);
      scrollTo(0);
      // …returned on a phone, whose tab bar starts at 700px.
      await back();
      expect(row(12).getBoundingClientRect().bottom).toBeLessThanOrEqual(
        tabBarTop,
      );
      expect(row(12).getBoundingClientRect().top).toBe(700 - 60 - 8);
    } finally {
      bar.remove();
    }
  });
});

describe('repeated returns over the same history entry (issue #356)', () => {
  let stopRestoring = () => {};
  beforeEach(() => {
    stopRestoring = restoreNatively();
  });
  afterEach(() => stopRestoring());

  it('Back → Forward → Back returns to the opened row, focused, every time', async () => {
    mount();
    scrollTo(pageTop(40) - 300);
    await openRow(40);
    scrollTo(0); // the detail is read at its top
    await back();
    expect(row(40).getBoundingClientRect().top).toBe(300);
    expect(document.activeElement).toBe(row(40));
    for (let cycle = 0; cycle < 3; cycle++) {
      await forward();
      expect(window.location.pathname).toBe('/item/40');
      await back();
      expect(window.location.pathname).toBe('/list');
      expect(row(40).getBoundingClientRect().top).toBe(300);
      expect(document.activeElement).toBe(row(40));
    }
  });

  it('a list left without opening a row returns to the same place again, no focus taken', async () => {
    mount();
    scrollTo(pageTop(30) - 17);
    await act(async () => {
      fireEvent.click(screen.getByText('Elsewhere'), { button: 0 });
    });
    scrollTo(0);
    await back();
    expect(window.scrollY).toBe(pageTop(30) - 17);
    await forward();
    await back();
    expect(window.scrollY).toBe(pageTop(30) - 17);
    expect(document.activeElement).toBe(document.body);
  });

  it('after the user scrolls the returned list, the next return is where they left it', async () => {
    mount();
    scrollTo(pageTop(40) - 300);
    await openRow(40);
    scrollTo(0);
    await back();
    fireEvent.wheel(window);
    scrollTo(pageTop(10) - 50);
    act(() => (document.activeElement as HTMLElement | null)?.blur());
    await forward();
    await back();
    expect(window.scrollY).toBe(pageTop(10) - 50);
    // The earlier row is no longer what the user left from.
    expect(document.activeElement).toBe(document.body);
  });

  it('Forward before the returned rows arrive keeps the pending return', async () => {
    mount();
    scrollTo(pageTop(40) - 300);
    await openRow(40);
    scrollTo(0);
    ready = false; // the list arrives loading
    await back();
    await forward();
    ready = true;
    await back();
    expect(row(40).getBoundingClientRect().top).toBe(300);
    expect(document.activeElement).toBe(row(40));
  });

  it('Forward while a failed refetch awaits Retry keeps the return', async () => {
    mount();
    scrollTo(pageTop(40) - 300);
    await openRow(40);
    scrollTo(0);
    await back();
    act(() => setReady(false)); // the refetch fails
    scrollTo(0); // the page collapsed to its top
    await forward();
    act(() => setReady(true));
    await back();
    expect(row(40).getBoundingClientRect().top).toBe(300);
    expect(document.activeElement).toBe(row(40));
  });

  it('late layout after a repeated return still re-anchors the row', async () => {
    mount();
    scrollTo(pageTop(40) - 300);
    await openRow(40);
    scrollTo(0);
    await back();
    await forward();
    await back();
    relayout(120);
    expect(row(40).getBoundingClientRect().top).toBe(300);
  });

  it('a new entry for the same list after repeated returns starts fresh', async () => {
    mount();
    scrollTo(pageTop(40) - 300);
    await openRow(40);
    scrollTo(0);
    await back();
    await forward();
    await act(async () => {
      fireEvent.click(screen.getByText('Fresh list'));
    });
    expect(window.location.pathname).toBe('/list');
    expect(window.scrollY).toBe(0);
    expect(document.activeElement).not.toBe(row(40));
  });
});
