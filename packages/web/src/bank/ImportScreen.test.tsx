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

  it('shows a status-check failure (jobQ.isError) with Check again / Start over, and hides the leave-open hint', async () => {
    vi.mocked(api.importBankStatement).mockResolvedValue({ jobId: 9 });
    vi.mocked(api.getBankImportStatus)
      .mockRejectedValueOnce(new Error('status endpoint down'))
      .mockResolvedValue({
        id: 9,
        status: 'done',
        account_code: 'BANK_EUR',
        statement_id: 12,
        error: null,
      });
    renderScreen();
    pickFile();
    fireEvent.click(screen.getByRole('button', { name: /import statement/i }));
    expect(await screen.findByText('status endpoint down')).toBeInTheDocument();
    // A failing status check must not still promise the job is progressing.
    expect(screen.queryByText(/Leave this screen open/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /start over/i }));
    // Start over returns to the upload form (same effect as the existing
    // job-failed panel's "Try again").
    expect(screen.getByLabelText('Statement file')).toBeInTheDocument();
  });

  it('"Check again" refetches the status endpoint and recovers into the done state', async () => {
    vi.mocked(api.importBankStatement).mockResolvedValue({ jobId: 9 });
    vi.mocked(api.getBankImportStatus)
      .mockRejectedValueOnce(new Error('status endpoint down'))
      .mockResolvedValue({
        id: 9,
        status: 'done',
        account_code: 'BANK_EUR',
        statement_id: 12,
        error: null,
      });
    renderScreen();
    pickFile();
    fireEvent.click(screen.getByRole('button', { name: /import statement/i }));
    await screen.findByText('status endpoint down');
    fireEvent.click(screen.getByRole('button', { name: /check again/i }));
    expect(await screen.findByText('Statement created')).toBeInTheDocument();
    expect(api.getBankImportStatus).toHaveBeenCalledTimes(2);
  });
});
