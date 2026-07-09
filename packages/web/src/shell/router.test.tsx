import { render, screen, waitFor } from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setToken } from '../auth';
import { buildRoutes } from './router';

function renderAt(path: string) {
  const router = createMemoryRouter(buildRoutes(), { initialEntries: [path] });
  render(<RouterProvider router={router} />);
  return router;
}

/** The new Inbox screens fetch on mount; route JSON per endpoint so any
 *  screen the router lands on renders without network noise. */
function mockApiFetch() {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    const json = (body: unknown) =>
      Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    if (url.includes('/api/triage/needs-triage')) return json({ items: [] });
    if (url.includes('/api/approvals/pending')) return json({ approvals: [] });
    if (url.includes('/api/expenses')) return json({ expenses: [] });
    if (url.includes('/api/sales-invoices')) return json({ invoices: [] });
    if (url.includes('/api/entities')) return json({ entities: [] });
    if (url.includes('/api/reporting-periods'))
      return json({ reportingPeriods: [] });
    if (url.includes('/api/documents/')) return json({});
    return json([]);
  });
}

describe('router', () => {
  beforeEach(() => {
    localStorage.clear();
    setToken('test-token');
    mockApiFetch();
  });
  afterEach(() => vi.restoreAllMocks());

  it('shows the token gate when no token is stored', () => {
    localStorage.clear();
    renderAt('/inbox');
    expect(
      screen.getByRole('heading', { name: /api token/i }),
    ).toBeInTheDocument();
  });

  it('redirects / to /inbox and renders the new queue screen', async () => {
    const router = renderAt('/');
    expect(router.state.location.pathname).toBe('/inbox');
    expect(
      await screen.findByRole('heading', { name: 'Inbox' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /^All$/ })).toBeInTheDocument();
  });

  it('redirects legacy /intake?expand=5 all the way to the triage detail route', async () => {
    const router = renderAt('/intake?expand=5');
    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/inbox/doc/5'),
    );
  });

  it('mounts ApprovalScreen at /inbox/approval/:id', async () => {
    renderAt('/inbox/approval/7');
    // No approval with id 7 in the empty mocked list — the "already
    // decided" state proves ApprovalScreen (not a 404/blank route) mounted.
    expect(await screen.findByText('Already decided')).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /back to inbox/i }),
    ).toHaveAttribute('href', '/inbox');
  });

  it('redirects legacy /approvals to the approvals segment', () => {
    const router = renderAt('/approvals');
    expect(router.state.location.pathname).toBe('/inbox');
    expect(router.state.location.search).toContain('seg=approvals');
  });

  it('redirects legacy /expenses to /books?tab=expenses', () => {
    const router = renderAt('/expenses');
    expect(router.state.location.pathname).toBe('/books');
    expect(router.state.location.search).toContain('tab=expenses');
  });

  it('renders legacy section tabs at /settings', () => {
    renderAt('/settings');
    expect(
      screen.getByRole('tab', { name: 'Organization' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Entities' })).toBeInTheDocument();
  });

  it('renders the new Bank statements screen at /bank', async () => {
    renderAt('/bank');
    expect(
      await screen.findByRole('heading', { name: 'Bank' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Import' })).toHaveAttribute(
      'href',
      '/bank/import',
    );
  });
});
