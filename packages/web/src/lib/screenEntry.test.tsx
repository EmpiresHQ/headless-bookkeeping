import { act, fireEvent, render, screen } from '@testing-library/react';
import { createPortal } from 'react-dom';
import {
  Suspense,
  lazy,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentType,
} from 'react';
import {
  Link,
  Outlet,
  RouterProvider,
  createBrowserRouter,
  useNavigate,
  useParams,
} from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setToken } from '../auth';
import { ScreenHeader } from '../shell/Headers';
import {
  POSITION_ROW,
  resetListPositions,
  useReturnPosition,
} from './listPosition';
import { resetScreenEntries, useScreenEntry } from './screenEntry';

/**
 * Issue #357 — a newly entered detail starts at its top with focus on its
 * title; a history return to it gets its own offset back. Layout is
 * simulated: the page height is the shown screen's (a long list, a short
 * loading detail, a tall ready one), and window.scrollTo clamps to it like
 * a browser does.
 */

const ROW_H = 60;
const pageTop = (i: number) => 100 + ROW_H * i;
const VIEWPORT = 768; // jsdom's innerHeight
let scrollY = 0;
let pageHeight = 0;
const maxScroll = () => Math.max(0, pageHeight - VIEWPORT);
const scrollTo = (y: number) => {
  scrollY = Math.max(0, Math.min(y, maxScroll()));
};

// The detail's data (its query), switchable mid-test.
let ready = true;
const listeners = new Set<() => void>();
const setReady = (v: boolean) => {
  ready = v;
  act(() => listeners.forEach((l) => l()));
};
const useReady = () =>
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => ready,
  );

// jsdom has no ResizeObserver: a controllable one.
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
const relayout = () =>
  act(() => observers.forEach((cb) => cb([], {} as ResizeObserver)));

function List() {
  const rootRef = useRef<HTMLDivElement>(null);
  useReturnPosition(rootRef, true);
  pageHeight = pageTop(80);
  return (
    <div ref={rootRef}>
      {Array.from({ length: 80 }, (_, i) => (
        <Link key={i} to={`/item/${i}`} data-i={i} {...{ [POSITION_ROW]: '' }}>
          row {i}
        </Link>
      ))}
    </div>
  );
}

// A modal layer over the detail, kept on the page while it "closes".
let layer = false;
const setLayer = (v: boolean) => {
  layer = v;
  act(() => listeners.forEach((l) => l()));
};
const useLayer = () =>
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => layer,
  );

const DETAIL_H = 3000;
function Detail() {
  const { id } = useParams();
  const isReady = useReady();
  const showLayer = useLayer();
  const navigate = useNavigate();
  useScreenEntry(isReady);
  pageHeight = isReady ? DETAIL_H : 400;
  return (
    <div>
      <ScreenHeader
        title={`Item ${id}`}
        heading={`Record R-${id}`}
        backTo="/list"
        trailing={<Link to="/held">Elsewhere</Link>}
      />
      {showLayer &&
        createPortal(
          <div role="alertdialog">
            <button
              type="button"
              onClick={() =>
                navigate(`/item/${Number(id) + 1}`, { replace: true })
              }
            >
              Archive
            </button>
          </div>,
          document.body,
        )}
      {isReady && (
        <>
          <input aria-label="Note" />
          <button
            type="button"
            onClick={() =>
              navigate(`/item/${Number(id) + 1}`, { replace: true })
            }
          >
            Next item
          </button>
          <button
            type="button"
            onClick={() => navigate('?tab=facts', { replace: true })}
          >
            Facts tab
          </button>
        </>
      )}
    </div>
  );
}

// A lazy detail chunk, held until the test releases it.
let releaseChunk: () => void = () => {};
function heldChunk() {
  return lazy(
    () =>
      new Promise<{ default: ComponentType }>((resolve) => {
        releaseChunk = () => resolve({ default: Detail });
      }),
  );
}

// The shell's shape (AppLayout): a Suspense boundary around the Outlet,
// which a route discard remounts by key.
let bumpOutlet: () => void = () => {};
function Shell() {
  const [epoch, setEpoch] = useState(0);
  bumpOutlet = () => setEpoch((e) => e + 1);
  return (
    <Suspense fallback={<p>Loading screen</p>}>
      <Outlet key={epoch} />
    </Suspense>
  );
}

// Another screen whose chunk is held (a lazy target still loading).
let releaseHeld: () => void = () => {};
function Held() {
  pageHeight = 1000;
  return <p>Held screen</p>;
}

function mount(detail: ComponentType = Detail) {
  const Screen = detail;
  const HeldScreen = lazy(
    () =>
      new Promise<{ default: ComponentType }>((resolve) => {
        releaseHeld = () => resolve({ default: Held });
      }),
  );
  const router = createBrowserRouter([
    {
      element: <Shell />,
      children: [
        { path: '/list', element: <List /> },
        { path: '/item/:id', element: <Screen /> },
        { path: '/held', element: <HeldScreen /> },
      ],
    },
  ]);
  return render(<RouterProvider router={router} />);
}

const row = (i: number) => screen.getByText(`row ${i}`);
// The record's h1, named by what it is (its visible text is the title).
const title = (id: number) =>
  screen.getByRole('heading', {
    level: 1,
    name: `Record R-${id}, Item ${id}`,
  });
async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 30));
  });
}
async function click(el: Element) {
  await act(async () => {
    fireEvent.click(el, { button: 0 });
  });
  await settle();
}
async function back() {
  await act(async () => {
    window.history.back();
  });
  await settle();
}
async function forward() {
  await act(async () => {
    window.history.forward();
  });
  await settle();
}

beforeEach(() => {
  resetListPositions();
  resetScreenEntries();
  setToken('token-a');
  ready = true;
  layer = false;
  scrollY = 0;
  pageHeight = 0;
  observers.clear();
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  window.history.replaceState(null, '', '/list');
  Object.defineProperty(window, 'scrollY', {
    configurable: true,
    get: () => scrollY,
  });
  Object.defineProperty(document.documentElement, 'scrollHeight', {
    configurable: true,
    get: () => pageHeight,
  });
  vi.spyOn(window, 'scrollTo').mockImplementation(((
    x: number | ScrollToOptions,
    y?: number,
  ) => {
    scrollTo(typeof x === 'number' ? (y ?? 0) : (x.top ?? 0));
  }) as typeof window.scrollTo);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    function (this: HTMLElement) {
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

describe('screen entry (issue #357)', () => {
  it('a detail opened from deep in a list starts at its top, title focused once loaded — only after the list was left, and Back still returns to the row', async () => {
    ready = false;
    mount(heldChunk());
    await settle();
    scrollTo(pageTop(40) - 300);
    await click(row(40));
    // The chunk is still loading: the list stays shown, and unscrolled.
    expect(row(40)).toBeInTheDocument();
    expect(window.scrollY).toBe(pageTop(40) - 300);

    await act(async () => releaseChunk());
    await settle();
    expect(window.location.pathname).toBe('/item/40');
    expect(window.scrollY).toBe(0);
    setReady(true);
    expect(document.activeElement).toBe(title(40));
    expect(window.scrollY).toBe(0);

    await back();
    expect(window.location.pathname).toBe('/list');
    expect(row(40).getBoundingClientRect().top).toBe(300);
    expect(document.activeElement).toBe(row(40));
  });

  it('auto-next (REPLACE to the next item on the same screen) starts at the top; a query-only REPLACE keeps the reading place and focus', async () => {
    mount();
    await settle();
    await click(row(12));
    scrollTo(900);
    await click(screen.getByText('Next item'));
    expect(window.location.pathname).toBe('/item/13');
    expect(window.scrollY).toBe(0);
    expect(document.activeElement).toBe(title(13));

    scrollTo(700);
    const facts = screen.getByText('Facts tab');
    facts.focus();
    await click(facts);
    expect(window.location.search).toBe('?tab=facts');
    expect(window.scrollY).toBe(700);
    expect(document.activeElement).toBe(facts);
  });

  it('Forward to a detail gets its own offset back once it has loaded; without its record (another sign-in) it starts at the top', async () => {
    mount();
    await settle();
    await click(row(5));
    scrollTo(1200);
    await back();
    expect(window.location.pathname).toBe('/list');

    ready = false;
    await forward();
    expect(window.location.pathname).toBe('/item/5');
    setReady(true);
    expect(window.scrollY).toBe(1200);
    expect(document.activeElement).toBe(title(5));

    await back();
    setToken('token-b');
    await forward();
    expect(window.location.pathname).toBe('/item/5');
    expect(window.scrollY).toBe(0);
  });

  it('a return left again before its data arrived keeps the offset it was returning to', async () => {
    mount();
    await settle();
    await click(row(5));
    scrollTo(1200);
    await back();
    ready = false;
    await forward();
    expect(window.scrollY).toBe(0); // clamped: still loading
    await back();
    ready = true;
    await forward();
    expect(window.scrollY).toBe(1200);
  });

  it('never places or focuses an outgoing detail once history moved on to a screen still loading', async () => {
    mount();
    await settle();
    await click(row(5));
    scrollTo(1200);
    await back();
    ready = false;
    await forward();
    // Leave for a screen whose chunk is held: the detail stays shown.
    await click(screen.getByText('Elsewhere'));
    expect(window.location.pathname).toBe('/held');
    expect(title(5)).toBeInTheDocument();
    setReady(true);
    relayout();
    expect(window.scrollY).toBe(0);
    expect(document.activeElement).not.toBe(title(5));

    await act(async () => releaseHeld());
    await settle();
    expect(screen.getByText('Held screen')).toBeInTheDocument();
    // Its record still holds the offset it was returning to.
    await back();
    expect(window.location.pathname).toBe('/item/5');
    expect(window.scrollY).toBe(1200);
  });

  it('auto-next from inside a still-closing dialog waits for it to go, then focuses the new title', async () => {
    mount();
    await settle();
    await click(row(12));
    setLayer(true);
    const archive = screen.getByText('Archive');
    archive.focus();
    await click(archive);
    expect(window.location.pathname).toBe('/item/13');
    expect(window.scrollY).toBe(0);
    // The outgoing layer is still on the page, holding focus.
    expect(document.activeElement).toBe(archive);
    setLayer(false);
    await settle();
    expect(document.activeElement).toBe(title(13));
  });

  it('a return still waiting for its page to grow stops at the user’s own scroll', async () => {
    mount();
    await settle();
    await click(row(5));
    scrollTo(1200);
    await back();
    ready = false;
    await forward();
    fireEvent.wheel(window);
    setReady(true);
    relayout();
    expect(window.scrollY).toBe(0);
  });

  it('never takes focus the user already moved while the detail was loading', async () => {
    ready = false;
    mount();
    await settle();
    await click(row(3));
    const other = document.createElement('button');
    document.body.appendChild(other);
    fireEvent.keyDown(window, { key: 'Tab' });
    other.focus();
    setReady(true);
    expect(document.activeElement).toBe(other);
    other.remove();
  });

  it('waits for a closing layer to un-hide the screen before focusing its title', async () => {
    const { container } = mount();
    await settle();
    container.setAttribute('aria-hidden', 'true');
    await click(row(3));
    expect(document.activeElement).toBe(document.body);
    await act(async () => container.removeAttribute('aria-hidden'));
    expect(document.activeElement).toBe(title(3));
  });

  it('a remount on the same entry (route discard) is no new arrival', async () => {
    mount();
    await settle();
    await click(row(3));
    scrollTo(500);
    act(() => bumpOutlet());
    expect(window.scrollY).toBe(500);
  });

  it('the page’s own first load is left to the browser', async () => {
    window.history.replaceState(null, '', '/item/7');
    mount();
    await settle();
    expect(window.scrollTo).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(document.body);
  });
});
