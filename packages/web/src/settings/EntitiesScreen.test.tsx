import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../api', async (io) => ({
  ...(await io<typeof import('../api')>()),
  getEntities: vi.fn(),
}));
import { getEntities, type Entity } from '../api';
import { EntitiesScreen } from './EntitiesScreen';

const ROWS: Entity[] = [
  {
    id: 1,
    role: 'supplier',
    country: 'EE',
    name: 'Circle K Eesti AS',
    goods_vs_services: 'goods',
  },
  {
    id: 2,
    role: 'customer',
    country: 'FI',
    name: 'Acme Oy',
    goods_vs_services: null,
  },
  {
    id: 3,
    role: 'employee',
    country: 'EE',
    name: 'Mari Maasikas',
    goods_vs_services: null,
  },
] as Entity[];

function mount(initial = '/settings/entities') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(
    [{ path: '/settings/entities', element: <EntitiesScreen /> }],
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
  vi.mocked(getEntities).mockResolvedValue(ROWS);
});

describe('EntitiesScreen', () => {
  it('lists name + role chip + country, no raw ids (data rule 1)', async () => {
    mount();
    expect(await screen.findByText('Circle K Eesti AS')).toBeInTheDocument();
    expect(screen.getByText('Supplier')).toBeInTheDocument();
    expect(screen.getByText('Employee')).toBeInTheDocument();
    expect(screen.queryByText('#1')).toBeNull();
    expect(screen.queryByText(/^1$/)).toBeNull();
  });

  it('Team segment filters to ADR-0036 claimants and survives in ?seg=', async () => {
    const router = mount('/settings/entities?seg=team');
    expect(await screen.findByText('Mari Maasikas')).toBeInTheDocument();
    expect(screen.queryByText('Circle K Eesti AS')).toBeNull();
    // Round-trip: switching writes ?seg=.
    fireEvent.click(screen.getByRole('tab', { name: 'Suppliers' }));
    await waitFor(() =>
      expect(router.state.location.search).toContain('seg=suppliers'),
    );
    expect(await screen.findByText('Circle K Eesti AS')).toBeInTheDocument();
  });

  it('search narrows by name and persists in ?q=', async () => {
    const router = mount();
    await screen.findByText('Circle K Eesti AS');
    fireEvent.change(screen.getByPlaceholderText('Search entities'), {
      target: { value: 'mari' },
    });
    await waitFor(() =>
      expect(router.state.location.search).toContain('q=mari'),
    );
    expect(screen.getByText('Mari Maasikas')).toBeInTheDocument();
    expect(screen.queryByText('Acme Oy')).toBeNull();
  });

  it('honest empty state on a fresh install points at creation', async () => {
    vi.mocked(getEntities).mockResolvedValue([]);
    mount();
    expect(await screen.findByText('No entities yet')).toBeInTheDocument();
    expect(
      screen.getByText(/Suppliers and customers are created automatically/),
    ).toBeInTheDocument();
  });

  it('read failure → LoadError with retry', async () => {
    vi.mocked(getEntities).mockRejectedValue(new Error('boom'));
    mount();
    expect(await screen.findByText('boom')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
