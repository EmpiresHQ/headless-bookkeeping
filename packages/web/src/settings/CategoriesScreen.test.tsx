import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../api', async (io) => ({
  ...(await io<typeof import('../api')>()),
  getCategories: vi.fn(),
  getOrganization: vi.fn(),
}));
import { getCategories, getOrganization } from '../api';
import { CategoriesScreen } from './CategoriesScreen';

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/settings/categories']}>
        <CategoriesScreen />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getCategories).mockResolvedValue([
    { key: 'software', label: 'Software', accountCode: 'EXPENSE_SOFTWARE' },
    { key: 'fuel', label: 'Fuel', accountCode: 'EXPENSE_FUEL' },
  ]);
  vi.mocked(getOrganization).mockResolvedValue({ country: 'EE' } as never);
});

describe('CategoriesScreen', () => {
  it('lists label + key and explains plugin ownership', async () => {
    mount();
    expect(await screen.findByText('Software')).toBeInTheDocument();
    expect(screen.getByText('Fuel')).toBeInTheDocument();
    expect(screen.getByText(/software/)).toBeInTheDocument();
    expect(
      screen.getByText(/Defined by the EE country plugin/),
    ).toBeInTheDocument();
  });

  it('NEVER renders the ledger accountCode (ADR-0030 — the legacy leak dies)', async () => {
    mount();
    await screen.findByText('Software');
    expect(screen.queryByText(/EXPENSE_SOFTWARE/)).toBeNull();
    expect(screen.queryByText(/EXPENSE_FUEL/)).toBeNull();
    expect(screen.queryByText(/[Aa]ccount/)).toBeNull();
  });
});
