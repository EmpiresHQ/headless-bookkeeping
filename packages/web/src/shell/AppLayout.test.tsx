import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  getNeedsTriageItems: vi.fn(),
  getPendingApprovals: vi.fn(),
}));

import * as api from '../api';
import { AppLayout } from './AppLayout';

function renderShell(path = '/inbox') {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const router = createMemoryRouter(
    [
      {
        element: <AppLayout onSignOut={vi.fn()} />,
        children: [
          { path: '/inbox', element: <p>inbox body</p> },
          { path: '/books', element: <p>books body</p> },
        ],
      },
    ],
    { initialEntries: [path] },
  );
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe('AppLayout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getNeedsTriageItems).mockResolvedValue([]);
    vi.mocked(api.getPendingApprovals).mockResolvedValue([]);
  });

  it('renders all five sections in both navs and the outlet content', () => {
    renderShell();
    expect(screen.getAllByRole('link', { name: /inbox/i })).toHaveLength(2);
    expect(screen.getAllByRole('link', { name: /books/i })).toHaveLength(2);
    expect(screen.getAllByRole('link', { name: /bank/i })).toHaveLength(2);
    expect(screen.getAllByRole('link', { name: /reports/i })).toHaveLength(2);
    expect(screen.getAllByRole('link', { name: /settings/i })).toHaveLength(2);
    expect(screen.getByText('inbox body')).toBeInTheDocument();
  });

  it('marks the active section', () => {
    renderShell('/books');
    const active = screen
      .getAllByRole('link', { name: /books/i })
      .map((a) => a.getAttribute('aria-current'));
    expect(active).toContain('page');
  });

  it('shows the live inbox badge in BOTH navs (triage + approvals summed)', async () => {
    vi.mocked(api.getNeedsTriageItems).mockResolvedValue([
      { id: 1, filename: 'a.pdf', created_at: 1, reason: 'x', reason_type: 'unknown' },
      { id: 2, filename: 'b.pdf', created_at: 2, reason: 'x', reason_type: 'unknown' },
    ]);
    vi.mocked(api.getPendingApprovals).mockResolvedValue([
      { id: 7, object_type: 'expense', object_id: 1, status: 'pending', requested_by: 'p', approved_by: null, rejected_reason: null, policy_reason: null, superseded_by: null, created_at: 3, resolved_at: null },
    ]);
    renderShell();
    await waitFor(() => expect(screen.getAllByText('3')).toHaveLength(2));
  });

  it('hides the badge at zero', async () => {
    renderShell();
    await waitFor(() => expect(api.getPendingApprovals).toHaveBeenCalled());
    expect(screen.queryByText('0')).not.toBeInTheDocument();
  });
});
