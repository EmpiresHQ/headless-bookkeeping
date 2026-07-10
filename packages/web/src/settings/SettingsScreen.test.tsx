import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { createMemoryRouter, Outlet, RouterProvider } from 'react-router-dom';
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../api', async (io) => ({
  ...(await io<typeof import('../api')>()),
  getOrganization: vi.fn(),
  getEntities: vi.fn(),
  getMailboxConnectors: vi.fn(),
}));
import { getEntities, getMailboxConnectors, getOrganization } from '../api';
import { SettingsScreen } from './SettingsScreen';

const onSignOut = vi.fn();

function mount(initial = '/settings') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(
    [
      {
        element: <Outlet context={{ onSignOut }} />,
        children: [
          { path: '/settings', element: <SettingsScreen /> },
          { path: '/settings/llm', element: <div>LLM SCREEN</div> },
          { path: '/settings/entities', element: <div>ENTITIES SCREEN</div> },
        ],
      },
    ],
    { initialEntries: [initial] },
  );
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getOrganization).mockResolvedValue({
    id: 1,
    country: 'EE',
    base_currency: null,
    vat_registered: true,
    org_type: 'company',
    created_at: 0,
    name: 'Acme OÜ',
    vat_registration_number: 'EE123456789',
    iban: null,
  } as never);
  vi.mocked(getEntities).mockResolvedValue([]);
  vi.mocked(getMailboxConnectors).mockResolvedValue([]);
});

describe('SettingsScreen (hub)', () => {
  it('renders the three groups with all eight rows', async () => {
    mount();
    expect(
      screen.getByRole('heading', { name: 'Settings' }),
    ).toBeInTheDocument();
    for (const row of [
      'Organization',
      'Entities',
      'Categories',
      'Mail intake',
      'Posting policy',
      'AI models',
      'Telegram & approvers',
      'Mobile device',
    ]) {
      expect(screen.getByText(row)).toBeInTheDocument();
    }
    // Org name arrives as the row subtitle once the shared cache resolves.
    await waitFor(() =>
      expect(screen.getByText('Acme OÜ')).toBeInTheDocument(),
    );
  });

  it('Sign out fires the shell callback (mobile parity)', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });

  it('redirects legacy ?tab= bookmarks: app → /settings/llm', async () => {
    const router = mount('/settings?tab=app');
    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/settings/llm'),
    );
    expect(screen.getByText('LLM SCREEN')).toBeInTheDocument();
  });

  it('redirects ?tab=entities to the sub-route', async () => {
    const router = mount('/settings?tab=entities');
    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/settings/entities'),
    );
  });

  it('ignores unknown ?tab= values (renders the hub)', () => {
    mount('/settings?tab=bogus');
    expect(
      screen.getByRole('heading', { name: 'Settings' }),
    ).toBeInTheDocument();
  });

  it('ignores ?tab=toString (prototype-chain key, not an own TAB_ROUTES entry)', () => {
    mount('/settings?tab=toString');
    expect(
      screen.getByRole('heading', { name: 'Settings' }),
    ).toBeInTheDocument();
  });
});
