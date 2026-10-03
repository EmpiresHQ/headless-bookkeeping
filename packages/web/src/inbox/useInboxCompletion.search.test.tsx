import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  getNeedsTriageItems: vi.fn(),
  getPendingApprovals: vi.fn(),
}));

import * as api from '../api';
import { UnsavedChangesProvider } from '../lib/unsavedChanges';
import { useInboxCompletion } from './useInboxCompletion';

function Item() {
  const { leave, backHref, context } = useInboxCompletion('/inbox/doc/12');
  return (
    <>
      <p>{context}</p>
      <p data-testid="back">{backHref}</p>
      <button type="button" onClick={() => leave('/inbox')}>
        decide
      </button>
    </>
  );
}

function renderItem(state: unknown) {
  const router = createMemoryRouter(
    [
      { path: '/inbox', element: <p>inbox list</p> },
      { path: '/inbox/doc/:id', element: <Item /> },
    ],
    { initialEntries: [{ pathname: '/inbox/doc/12', state }] },
  );
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <UnsavedChangesProvider onUnauthorized={() => undefined}>
        <RouterProvider router={router} />
      </UnsavedChangesProvider>
    </QueryClientProvider>,
  );
  return router;
}

describe('useInboxCompletion — a search hit returns to its exact list (issue #278)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getNeedsTriageItems).mockResolvedValue([]);
    vi.mocked(api.getPendingApprovals).mockResolvedValue([]);
  });

  it('without the #252 proof, the fallback is the recorded /inbox href with its ?q=/?seg= and state', async () => {
    const listState = { mine: 1 };
    const router = renderItem({
      // idx null: no proof — the fallback path is taken.
      hbkOrigin: {
        href: '/inbox?seg=triage&q=cheque',
        state: listState,
        idx: null,
        key: 'list',
      },
    });
    expect(
      await screen.findByText('Single item · returns to Inbox'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('back')).toHaveTextContent(
      '/inbox?seg=triage&q=cheque',
    );
    fireEvent.click(screen.getByRole('button', { name: 'decide' }));
    await screen.findByText('inbox list');
    expect(router.state.location.search).toBe('?seg=triage&q=cheque');
    expect(router.state.location.state).toEqual(listState);
    expect(router.state.historyAction).toBe('REPLACE');
  });

  it('a queue run still falls back to its segment list (unchanged)', async () => {
    const router = renderItem({
      hbkRun: { seg: 'triage', members: ['/inbox/doc/12'] },
      hbkOrigin: {
        href: '/inbox?seg=triage&q=cheque',
        state: null,
        idx: null,
        key: 'list',
      },
    });
    expect(screen.getByTestId('back')).toHaveTextContent('/inbox?seg=triage');
    await waitFor(() =>
      expect(screen.getByText(/Triage queue/)).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'decide' }));
    await screen.findByText('inbox list');
    expect(router.state.location.search).toBe('?seg=triage');
  });

  it('no origin at all: bare /inbox (unchanged)', async () => {
    const router = renderItem(null);
    fireEvent.click(await screen.findByRole('button', { name: 'decide' }));
    await screen.findByText('inbox list');
    expect(router.state.location.search).toBe('');
  });
});
