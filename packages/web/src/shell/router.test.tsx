import { render, screen } from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';
import { setToken } from '../auth';
import { buildRoutes } from './router';

function renderAt(path: string) {
  const router = createMemoryRouter(buildRoutes(), { initialEntries: [path] });
  render(<RouterProvider router={router} />);
  return router;
}

describe('router', () => {
  beforeEach(() => {
    localStorage.clear();
    setToken('test-token');
  });

  it('shows the token gate when no token is stored', () => {
    localStorage.clear();
    renderAt('/inbox');
    // getByText(/api token/i) is ambiguous: it also matches the TokenGate
    // helper paragraph ("Paste an API token..."). Target the heading.
    expect(
      screen.getByRole('heading', { name: /api token/i }),
    ).toBeInTheDocument();
  });

  it('redirects / to /inbox', () => {
    const router = renderAt('/');
    expect(router.state.location.pathname).toBe('/inbox');
  });

  it('redirects legacy /intake to /inbox preserving search params', () => {
    const router = renderAt('/intake?expand=5');
    expect(router.state.location.pathname).toBe('/inbox');
    const params = new URLSearchParams(router.state.location.search);
    expect(params.get('tab')).toBe('triage');
    expect(params.get('expand')).toBe('5');
  });

  it('redirects legacy /expenses to /books?tab=expenses', () => {
    const router = renderAt('/expenses');
    expect(router.state.location.pathname).toBe('/books');
    expect(router.state.location.search).toContain('tab=expenses');
  });

  it('renders legacy section tabs at /settings', () => {
    renderAt('/settings');
    // LegacyTabs segmented control for the settings section.
    expect(
      screen.getByRole('tab', { name: 'Organization' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Entities' })).toBeInTheDocument();
  });
});
