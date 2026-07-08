import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api', () => ({
  listBankStatements: vi.fn(),
  listBankTransactions: vi.fn(),
  getReconciliationStatus: vi.fn(),
  getStatementMatches: vi.fn(),
  proposeMatches: vi.fn(),
  getMatchCandidates: vi.fn(),
  getBankImportStatus: vi.fn(),
  executeMatches: vi.fn(),
  manualMatch: vi.fn(),
  unmatchMatch: vi.fn(),
  approveApproval: vi.fn(),
  getPendingApprovals: vi.fn(),
  createExpense: vi.fn(),
  postExpense: vi.fn(),
  getCategories: vi.fn(),
  getEntities: vi.fn(),
  getOrganization: vi.fn(),
}));

import * as api from '../api';
import { StatementsScreen } from './StatementsScreen';

function renderScreen() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const router = createMemoryRouter(
    [
      { path: '/bank', element: <StatementsScreen /> },
      { path: '/bank/import', element: <p>import screen</p> },
      { path: '/bank/statements/:id', element: <p>statement screen</p> },
    ],
    { initialEntries: ['/bank'] },
  );
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

describe('StatementsScreen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.listBankTransactions).mockResolvedValue([]);
    vi.mocked(api.getReconciliationStatus).mockResolvedValue([]);
  });

  it('lists statements as period rows linking to the statement screen', async () => {
    vi.mocked(api.listBankStatements).mockResolvedValue([
      {
        id: 3,
        start_date: '2026-06-01',
        end_date: '2026-06-30',
        uploaded_at: 1,
      },
    ]);
    renderScreen();
    const row = await screen.findByRole('link', { name: /Jun 2026/ });
    expect(row).toHaveAttribute('href', '/bank/statements/3');
  });

  it('shows the unmatched badge from the reconciliation join', async () => {
    vi.mocked(api.listBankStatements).mockResolvedValue([
      {
        id: 3,
        start_date: '2026-06-01',
        end_date: '2026-06-30',
        uploaded_at: 1,
      },
    ]);
    vi.mocked(api.listBankTransactions).mockResolvedValue([
      {
        id: 9,
        transaction_date: '2026-06-27',
        description: 'WOLT',
        amount: -1860,
        currency: 'EUR',
        counterparty_iban: null,
        counterparty_descriptor: null,
        reference: null,
        status: 'open',
      },
      {
        id: 10,
        transaction_date: '2026-06-24',
        description: 'ELISA',
        amount: -3500,
        currency: 'EUR',
        counterparty_iban: null,
        counterparty_descriptor: null,
        reference: null,
        status: 'open',
      },
    ]);
    vi.mocked(api.getReconciliationStatus).mockResolvedValue([
      {
        bankTransactionId: 9,
        amountBase: 1860,
        matchedSum: 0,
        remaining: 1860,
        reconStatus: 'open',
      },
      {
        bankTransactionId: 10,
        amountBase: 3500,
        matchedSum: 3500,
        remaining: 0,
        reconStatus: 'matched',
      },
    ]);
    renderScreen();
    expect(await screen.findByText('1 unmatched')).toBeInTheDocument();
  });

  it('shows a done chip when everything is reconciled', async () => {
    vi.mocked(api.listBankStatements).mockResolvedValue([
      {
        id: 3,
        start_date: '2026-06-01',
        end_date: '2026-06-30',
        uploaded_at: 1,
      },
    ]);
    renderScreen();
    expect(await screen.findByText('done ✓')).toBeInTheDocument();
  });

  it('shows an empty state with an import CTA when there are no statements', async () => {
    vi.mocked(api.listBankStatements).mockResolvedValue([]);
    renderScreen();
    expect(await screen.findByText('No statements yet')).toBeInTheDocument();
    expect(
      screen.getAllByRole('link', { name: /import/i }).length,
    ).toBeGreaterThan(0);
  });
});
