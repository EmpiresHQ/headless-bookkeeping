import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { useEffect, useState } from 'react';
import {
  Link,
  Outlet,
  RouterProvider,
  createBrowserRouter,
} from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setToken } from '../auth';
import {
  useCompletionNavigation,
  useOriginState,
} from '../lib/returnNavigation';
import { UnsavedChangesProvider } from '../lib/unsavedChanges';
import { ConfirmDialog } from '../ui/ConfirmDialog';

/**
 * Issue #267 × #252: a finished task's own modal layer (the sheet or dialog
 * it was decided in) may still be registered when the router settles the
 * chain's replacement — its closing commit can land later. That layer must
 * not stop the return chain before its origin POP; a layer opened AFTER the
 * chain started still must.
 *
 * In a browser the finished task's close commit can land after the router
 * settles the replacement (a success handler runs from a promise; the
 * router notifies synchronously). jsdom commits earlier, so the task's
 * layer here lives in the layout and its close is DEFERRED under the
 * test's control (`closeTask`) — it stays registered across the whole
 * chain and the next Back.
 */

function List() {
  const origin = useOriginState();
  return (
    <Link to="/task" state={origin}>
      Open task
    </Link>
  );
}

function Task() {
  useEffect(() => openTask(), []);
  return <p>Task</p>;
}

let openTask: () => void = () => undefined;
let closeTask: () => void = () => undefined;

function Layout({ openNewerAtFinish }: { openNewerAtFinish: boolean }) {
  const { returnTo } = useCompletionNavigation();
  const [task, setTask] = useState(false);
  const [newer, setNewer] = useState(false);
  openTask = () => setTask(true);
  closeTask = () => setTask(false);
  return (
    <>
      <Outlet />
      <ConfirmDialog
        open={task}
        onOpenChange={() => undefined}
        title="Decide"
        body={
          <button
            type="button"
            onClick={() => {
              returnTo({ fallback: '/list' });
              if (openNewerAtFinish) setNewer(true);
            }}
          >
            Finish
          </button>
        }
        confirmLabel="OK"
        onConfirm={() => undefined}
      />
      <ConfirmDialog
        open={newer}
        onOpenChange={() => undefined}
        title="Newer"
        body="A modal opened after the chain started"
        confirmLabel="OK"
        onConfirm={() => undefined}
      />
    </>
  );
}

let routers: { dispose: () => void }[] = [];

function renderApp(openNewerAtFinish = false) {
  window.history.replaceState(null, '', '/start');
  const router = createBrowserRouter([
    {
      element: (
        <UnsavedChangesProvider onUnauthorized={() => undefined}>
          <Layout openNewerAtFinish={openNewerAtFinish} />
        </UnsavedChangesProvider>
      ),
      children: [
        { path: '/start', element: <Link to="/list">List</Link> },
        { path: '/list', element: <List /> },
        { path: '/task', element: <Task /> },
      ],
    },
  ]);
  routers.push(router);
  render(<RouterProvider router={router} />);
  return router;
}

const here = () => window.location.pathname;
const idx = () => (window.history.state as { idx: number }).idx;

async function expectAt(path: string, at: number) {
  await waitFor(() => {
    expect(here()).toBe(path);
    expect(idx()).toBe(at);
  });
}

async function goToTask() {
  fireEvent.click(await screen.findByText('List'));
  fireEvent.click(await screen.findByText('Open task'));
  await expectAt('/task', 2);
  await screen.findByRole('button', { name: 'Finish' });
}

describe('return chain vs the finished task’s modal layer (#267 × #252)', () => {
  beforeEach(() => setToken('test-token'));
  afterEach(() => {
    for (const r of routers) r.dispose();
    routers = [];
  });

  it('the task’s own still-registered layer neither stops the origin POP nor eats the next Back', async () => {
    renderApp();
    await goToTask();

    fireEvent.click(screen.getByRole('button', { name: 'Finish' }));
    // POPped onto the REAL origin entry (index 1), not left on its copy —
    // while the task's layer is still registered (its close not committed).
    await expectAt('/list', 1);
    expect(screen.getByRole('alertdialog', { name: 'Decide' })).toBeVisible();

    // The very next Back, still before that close: an ordinary leave, not
    // consumed by the outgoing layer (it stays retired after the chain).
    act(() => window.history.back());
    await expectAt('/start', 0);
    expect(screen.getByRole('alertdialog', { name: 'Decide' })).toBeVisible();
    act(() => closeTask());
  });

  it('a layer opened after the chain started still ends it at the safe copy', async () => {
    renderApp(true);
    await goToTask();

    fireEvent.click(screen.getByRole('button', { name: 'Finish' }));
    await waitFor(() => expect(here()).toBe('/list'));
    // Settle: any (wrong) late POP would have landed by now.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 100));
    });
    expect(idx()).toBe(2);
    expect(screen.getByRole('alertdialog', { name: 'Newer' })).toBeVisible();
    act(() => closeTask());
  });
});
