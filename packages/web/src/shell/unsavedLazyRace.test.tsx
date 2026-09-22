import { act, fireEvent, render, screen } from '@testing-library/react';
import { lazy, useState, type ComponentType } from 'react';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setToken } from '../auth';
import { useUnsavedChanges } from '../lib/unsavedChanges';
import { Root } from './Root';

/**
 * Issue #250 — a confirmed route discard must really discard. Navigations run
 * in a React transition: while the target screen's lazy chunk is still
 * loading, React keeps the OLD screen on display, so a quick reversal
 * (Back → Forward before the chunk lands) would come back to the very form
 * instance that was just discarded — its values intact but already released
 * as clean. The deferred lazy route below holds that window open; the test
 * reverses WITHOUT waiting for anything to unmount.
 */

function DraftForm() {
  const [value, setValue] = useState('Saved');
  useUnsavedChanges({ label: 'Draft form', values: value, baseline: 'Saved' });
  return (
    <input
      aria-label="Draft"
      value={value}
      onChange={(e) => setValue(e.target.value)}
    />
  );
}

let release: (m: { default: ComponentType }) => void = () => undefined;

function renderRace() {
  const Slow = lazy(
    () =>
      new Promise<{ default: ComponentType }>((resolve) => {
        release = resolve;
      }),
  );
  const router = createMemoryRouter(
    [
      {
        element: <Root />,
        children: [
          { path: '/form', element: <DraftForm /> },
          { path: '/slow', element: <Slow /> },
        ],
      },
    ],
    // Back from /form lands on the never-yet-loaded slow screen.
    { initialEntries: ['/slow', '/form'], initialIndex: 1 },
  );
  render(<RouterProvider router={router} />);
  return router;
}

describe('confirmed route discard vs. a lazy target (#250)', () => {
  beforeEach(() => {
    localStorage.clear();
    setToken('test-token');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify([]), { status: 200 }),
    );
  });
  afterEach(() => vi.restoreAllMocks());

  it('Back → Discard → immediate Forward (chunk still loading) returns to a FRESH form', async () => {
    const router = renderRace();
    fireEvent.change(await screen.findByLabelText('Draft'), {
      target: { value: 'Unsaved' },
    });

    void router.navigate(-1);
    fireEvent.click(await screen.findByRole('button', { name: 'Discard' }));
    // No waiting for the slow screen or for the form to unmount: reverse at
    // once, while the Back navigation is still pending on the lazy chunk.
    await act(async () => {
      await router.navigate(1);
    });

    expect(router.state.location.pathname).toBe('/form');
    expect(screen.getByLabelText('Draft')).toHaveValue('Saved');
    // And it is honestly clean: leaving again does not ask.
    expect(screen.queryByRole('alertdialog')).toBeNull();

    await act(async () => release({ default: () => <p>Slow screen</p> }));
  });
});
