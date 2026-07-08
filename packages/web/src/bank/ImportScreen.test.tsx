import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api', () => ({
  importBankStatement: vi.fn(),
  getBankImportStatus: vi.fn(),
  listBankStatements: vi.fn(),
  listBankTransactions: vi.fn(),
  getReconciliationStatus: vi.fn(),
  getStatementMatches: vi.fn(),
  proposeMatches: vi.fn(),
  getMatchCandidates: vi.fn(),
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
import { ImportScreen } from './ImportScreen';

function renderScreen() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const router = createMemoryRouter(
    [
      { path: '/bank/import', element: <ImportScreen /> },
      { path: '/bank', element: <p>bank list</p> },
      { path: '/bank/statements/:id', element: <p>statement screen</p> },
    ],
    { initialEntries: ['/bank/import'] },
  );
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

const pickFile = () => {
  const file = new File(['date;amount'], 'june.csv', { type: 'text/csv' });
  fireEvent.change(screen.getByLabelText('Statement file'), {
    target: { files: [file] },
  });
};

describe('ImportScreen', () => {
  beforeEach(() => vi.clearAllMocks());

  it('submits the file + account code and shows the done stepper with a statement link', async () => {
    vi.mocked(api.importBankStatement).mockResolvedValue({ jobId: 7 });
    // First (immediate) poll already returns done — no fake timers needed.
    vi.mocked(api.getBankImportStatus).mockResolvedValue({
      id: 7,
      status: 'done',
      account_code: 'BANK_EUR',
      statement_id: 5,
      error: null,
    });
    renderScreen();
    pickFile();
    fireEvent.click(screen.getByRole('button', { name: /import statement/i }));
    expect(await screen.findByText('Statement created')).toBeInTheDocument();
    const open = await screen.findByRole('link', { name: /open statement/i });
    expect(open).toHaveAttribute('href', '/bank/statements/5');
    expect(api.importBankStatement).toHaveBeenCalledWith(
      expect.any(File),
      'BANK_EUR',
    );
  });

  it('shows the explicit failure state with the server error and a try-again CTA', async () => {
    vi.mocked(api.importBankStatement).mockResolvedValue({ jobId: 8 });
    vi.mocked(api.getBankImportStatus).mockResolvedValue({
      id: 8,
      status: 'failed',
      account_code: 'BANK_EUR',
      statement_id: null,
      error: 'LLM mapping failed: unrecognizable columns',
    });
    renderScreen();
    pickFile();
    fireEvent.click(screen.getByRole('button', { name: /import statement/i }));
    expect(
      await screen.findByText('LLM mapping failed: unrecognizable columns'),
    ).toBeInTheDocument();
    // Try again returns to the upload form.
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(screen.getByLabelText('Statement file')).toBeInTheDocument();
  });

  it('disables submit until a file is chosen', () => {
    renderScreen();
    expect(
      screen.getByRole('button', { name: /import statement/i }),
    ).toBeDisabled();
  });
});
