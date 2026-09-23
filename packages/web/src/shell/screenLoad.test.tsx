import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { useEffect, useState, type ComponentType } from 'react';
import {
  RouterProvider,
  createMemoryRouter,
  type RouteObject,
} from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TOKEN_KEY, setToken } from '../auth';
import { usePendingOperation } from '../lib/pendingOperation';
import { reloadPage } from '../lib/reloadPage';
import { useResultLog } from '../lib/resultLog';
import { useUnsavedChanges } from '../lib/unsavedChanges';
import { Root } from './Root';
import { lazyScreen } from './ScreenFailure';
import { buildRoutes } from './router';

/**
 * Issue #292 — a routed screen whose code cannot be loaded (network drop, or
 * an old page asking for a chunk a newer deployment removed) is a failed
 * screen INSIDE the shell, not the router's whole-page error; and it is not
 * the unknown-address state (#291) nor an endless skeleton.
 */

vi.mock('../lib/reloadPage', () => ({ reloadPage: vi.fn() }));

// The production Settings chunk: its import stays pending until the test
// rejects it — a real import() rejection through router.tsx's lazy screen.
const settingsChunk = vi.hoisted(() => ({
  fail: (_e: unknown): void => undefined,
}));
vi.mock(
  '../settings/SettingsScreen',
  () =>
    new Promise((_resolve, reject) => {
      settingsChunk.fail = reject;
    }),
);

const CHUNK_URL = 'https://app.example/assets/SettingsScreen-0ld4ash.js';

const loadFailure = () =>
  screen.findByRole('heading', {
    level: 1,
    name: 'This screen could not be loaded',
  });
const reloadButton = () => screen.getByRole('button', { name: 'Reload page' });

function where(router: ReturnType<typeof createMemoryRouter>) {
  const { pathname, search, hash } = router.state.location;
  return pathname + search + hash;
}

function mockApiFetch() {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    const json = (body: unknown) =>
      Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    if (url.includes('/api/triage/needs-triage')) return json({ items: [] });
    if (url.includes('/api/approvals')) return json({ approvals: [] });
    return json([]);
  });
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  setToken('test-token');
  mockApiFetch();
  vi.mocked(reloadPage).mockClear();
});
afterEach(() => vi.restoreAllMocks());

describe('production routes: a screen chunk that fails to load', () => {
  it('stays pending, then fails in place inside the shell; Back, sections and Reload recover', async () => {
    const router = createMemoryRouter(buildRoutes(), {
      initialEntries: ['/inbox'],
    });
    render(<RouterProvider router={router} />);
    await screen.findByRole('heading', { name: 'Inbox' });

    void router.navigate('/settings?seg=a%20b#top');
    // Pending: the transition keeps the working screen, no failure yet.
    await act(async () => undefined);
    expect(
      screen.queryByRole('heading', {
        name: 'This screen could not be loaded',
      }),
    ).toBeNull();

    await act(async () => {
      settingsChunk.fail(
        new TypeError(
          `Failed to fetch dynamically imported module: ${CHUNK_URL}`,
        ),
      );
    });
    await loadFailure();
    // The address the person asked for is kept, query and hash included.
    expect(where(router)).toBe('/settings?seg=a%20b#top');
    // Not the router's whole-page error; no raw chunk URL or stack.
    expect(screen.queryByText(/Unexpected Application Error/)).toBeNull();
    expect(document.body.textContent).not.toContain('SettingsScreen-');
    expect(document.body.textContent).not.toContain('dynamically imported');
    // Not the unknown-address state either.
    expect(
      screen.queryByText('This address does not open a screen'),
    ).toBeNull();
    // The shell survived: its own navigation is still there.
    expect(
      within(screen.getByRole('navigation')).getByRole('link', {
        name: /Books/,
      }),
    ).toBeTruthy();

    // Back (a memory router has no in-app browser history, so this is the
    // deep-link Back: the Inbox REPLACES the failed entry).
    fireEvent.click(screen.getByRole('link', { name: '‹ Back' }));
    await screen.findByRole('heading', { name: 'Inbox' });
    expect(where(router)).toBe('/inbox');

    // Re-entering the failed screen shows the failure at once — never an
    // endless skeleton, and never a silent new attempt.
    await act(async () => {
      await router.navigate('/settings?seg=a%20b#top');
    });
    expect(
      screen.getByRole('heading', { name: 'This screen could not be loaded' }),
    ).toBeTruthy();
    expect(screen.queryAllByTestId('skeleton-row')).toHaveLength(0);

    // A section from the failure list pushes to a working screen.
    const sections = screen.getByText('Or go to a section').parentElement!;
    fireEvent.click(within(sections).getByRole('link', { name: /Inbox/ }));
    await screen.findByRole('heading', { name: 'Inbox' });

    // Reload is the honest retry: a real page reload of the same address.
    await act(async () => {
      await router.navigate(-1);
    });
    await loadFailure();
    fireEvent.click(reloadButton());
    expect(reloadPage).toHaveBeenCalledTimes(1);
    expect(where(router)).toBe('/settings?seg=a%20b#top');

    // An unknown address is still Not found (#291), not a failed screen.
    await act(async () => {
      await router.navigate('/settngs');
    });
    await screen.findByRole('heading', {
      level: 1,
      name: 'This address does not open a screen',
    });
  });
});

/* Own routes under the real Root/AppLayout, with a fresh lazy screen per
 * test (React caches a lazy's rejection for the module's life). */
function deferredScreen() {
  let fail: (e: unknown) => void = () => undefined;
  // Settled whenever the test says, whether or not React has asked yet.
  const chunk = new Promise<{ default: ComponentType }>((_resolve, reject) => {
    fail = reject;
  });
  chunk.catch(() => undefined);
  return { Screen: lazyScreen(() => chunk), fail };
}

function renderShell(children: RouteObject[], initialEntries: string[]) {
  const router = createMemoryRouter([{ element: <Root />, children }], {
    initialEntries,
    initialIndex: initialEntries.length - 1,
  });
  render(<RouterProvider router={router} />);
  return router;
}

function Home() {
  return <h1>Home screen</h1>;
}

describe('failed screen inside the shell', () => {
  it('a deep link shows the skeleton while loading, then the failure (not an endless skeleton)', async () => {
    const slow = deferredScreen();
    renderShell([{ path: '/slow', element: <slow.Screen /> }], ['/slow']);
    expect(screen.getAllByTestId('skeleton-row').length).toBeGreaterThan(0);
    expect(screen.queryByRole('alert')).toBeNull();

    await act(async () => slow.fail(new TypeError('Load failed')));
    await loadFailure();
    expect(screen.queryAllByTestId('skeleton-row')).toHaveLength(0);
    // Deep link: Back replaces this entry with the Inbox, like Not found.
    expect(screen.getByRole('link', { name: '‹ Back' })).toHaveAttribute(
      'href',
      '/inbox',
    );
  });

  it('a screen that throws while rendering gets generic copy, not a load failure', async () => {
    function Broken(): never {
      throw new Error('boom at /api/secret?token=abc');
    }
    const router = renderShell(
      [
        { path: '/home', element: <Home /> },
        { path: '/broken', element: <Broken /> },
      ],
      ['/home', '/broken'],
    );
    await screen.findByRole('heading', {
      level: 1,
      name: 'This screen stopped working',
    });
    expect(screen.queryByText('This screen could not be loaded')).toBeNull();
    expect(document.body.textContent).not.toContain('secret');
    expect(document.body.textContent).not.toMatch(/offline|updated|deploy/i);

    await act(async () => {
      await router.navigate(-1);
    });
    expect(screen.getByRole('heading', { name: 'Home screen' })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('recorded results stay above a failed screen', async () => {
    function Records() {
      const log = useResultLog();
      useEffect(() => {
        log.record({
          action: 'Upload',
          title: 'receipt.pdf',
          outcome: 'Recorded',
          tone: 'ok',
          links: [],
        });
        // Once per mount.
      }, []);
      return <h1>Home screen</h1>;
    }
    const slow = deferredScreen();
    const router = renderShell(
      [
        { path: '/home', element: <Records /> },
        { path: '/slow', element: <slow.Screen /> },
      ],
      ['/home'],
    );
    const results = await screen.findByRole('region', {
      name: 'Recent results',
    });
    expect(within(results).getByText('receipt.pdf')).toBeTruthy();

    void router.navigate('/slow');
    await act(async () => slow.fail(new TypeError('Load failed')));
    await loadFailure();
    expect(
      within(screen.getByRole('region', { name: 'Recent results' })).getByText(
        'receipt.pdf',
      ),
    ).toBeTruthy();
  });

  it('Reload is refused while an operation is still saving, and never replays it', async () => {
    let finish: () => void = () => undefined;
    const perform = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const onSuccess = vi.fn();
    function SavesThenBreaks() {
      const op = usePendingOperation('Save policy');
      const [broken, setBroken] = useState(false);
      if (broken) throw new Error('render failed');
      return (
        <button
          type="button"
          onClick={() => {
            op.run(perform, { onSuccess });
            setBroken(true);
          }}
        >
          Save
        </button>
      );
    }
    renderShell([{ path: '/form', element: <SavesThenBreaks /> }], ['/form']);
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }));
    await screen.findByRole('heading', { name: 'This screen stopped working' });

    fireEvent.click(reloadButton());
    expect(reloadPage).not.toHaveBeenCalled();

    await act(async () => finish());
    fireEvent.click(reloadButton());
    expect(reloadPage).toHaveBeenCalledTimes(1);
    // The write ran once; its screen is gone, so no continuation ran.
    expect(perform).toHaveBeenCalledTimes(1);
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('a signed-out session still goes to the token gate from a failed screen', async () => {
    const slow = deferredScreen();
    renderShell([{ path: '/slow', element: <slow.Screen /> }], ['/slow']);
    await act(async () => slow.fail(new TypeError('Load failed')));
    await loadFailure();

    act(() => {
      localStorage.removeItem(TOKEN_KEY);
      window.dispatchEvent(new StorageEvent('storage', { key: TOKEN_KEY }));
    });
    expect(screen.getByLabelText('API token')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Reload page' })).toBeNull();
  });
});

describe('confirmed discard vs. a lazy target that then fails (#250)', () => {
  function DraftForm() {
    const [value, setValue] = useState('Saved');
    useUnsavedChanges({
      label: 'Draft form',
      values: value,
      baseline: 'Saved',
    });
    return (
      <input
        aria-label="Draft"
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
    );
  }

  it('the held transition never resurrects the discarded draft, before or after the failure', async () => {
    const slow = deferredScreen();
    const router = renderShell(
      [
        { path: '/form', element: <DraftForm /> },
        { path: '/slow', element: <slow.Screen /> },
      ],
      ['/slow', '/form'],
    );
    fireEvent.change(await screen.findByLabelText('Draft'), {
      target: { value: 'Unsaved' },
    });

    void router.navigate(-1);
    fireEvent.click(await screen.findByRole('button', { name: 'Discard' }));
    await act(async () => {
      await router.navigate(1);
    });
    expect(screen.getByLabelText('Draft')).toHaveValue('Saved');

    await act(async () => slow.fail(new TypeError('Load failed')));
    await act(async () => {
      await router.navigate(-1);
    });
    await loadFailure();
    await act(async () => {
      await router.navigate(1);
    });
    await waitFor(() =>
      expect(screen.getByLabelText('Draft')).toHaveValue('Saved'),
    );
    // Honestly clean: leaving does not ask.
    await act(async () => {
      await router.navigate(-1);
    });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await loadFailure();
  });
});
