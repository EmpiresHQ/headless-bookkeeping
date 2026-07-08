import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
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
  deleteBankStatement: vi.fn(),
  fmtCents: (cents: number) => (cents / 100).toFixed(2),
}));

import * as api from '../api';
import { StatementScreen } from './StatementScreen';
import { AppToaster } from '../ui/toast';

function renderAt(path = '/bank/statements/3') {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const router = createMemoryRouter(
    [
      { path: '/bank', element: <p>bank list</p> },
      { path: '/bank/statements/:id', element: <StatementScreen /> },
      { path: '/bank/statements/:id/tx/:txId', element: <p>tx screen</p> },
    ],
    { initialEntries: [path] },
  );
  render(
    <QueryClientProvider client={client}>
      <>
        <RouterProvider router={router} />
        <AppToaster />
      </>
    </QueryClientProvider>,
  );
  return router;
}

const TXNS = [
  {
    id: 9,
    transaction_date: '2026-06-27',
    description: 'WOLT 220627',
    amount: -1860,
    currency: 'EUR',
    counterparty_iban: null,
    counterparty_descriptor: null,
    reference: null,
    status: 'open',
  },
  {
    id: 10,
    transaction_date: '2026-06-28',
    description: 'NORDIC CONSULT',
    amount: 120000,
    currency: 'EUR',
    counterparty_iban: null,
    counterparty_descriptor: null,
    reference: null,
    status: 'open',
  },
  {
    id: 11,
    transaction_date: '2026-06-24',
    description: 'ELISA arve 6/2026',
    amount: -3500,
    currency: 'EUR',
    counterparty_iban: null,
    counterparty_descriptor: null,
    reference: null,
    status: 'open',
  },
  {
    id: 12,
    transaction_date: '2026-06-20',
    description: 'OWNER LUNCH',
    amount: -900,
    currency: 'EUR',
    counterparty_iban: null,
    counterparty_descriptor: null,
    reference: null,
    status: 'personal',
  },
];

function mockStatementData() {
  vi.mocked(api.listBankStatements).mockResolvedValue([
    { id: 3, start_date: '2026-06-01', end_date: '2026-06-30', uploaded_at: 1 },
  ]);
  vi.mocked(api.listBankTransactions).mockResolvedValue(TXNS as never);
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
      amountBase: 120000,
      matchedSum: 0,
      remaining: 120000,
      reconStatus: 'open',
    },
    {
      bankTransactionId: 11,
      amountBase: 3500,
      matchedSum: 3500,
      remaining: 0,
      reconStatus: 'matched',
    },
    {
      bankTransactionId: 12,
      amountBase: 900,
      matchedSum: 0,
      remaining: 900,
      reconStatus: 'open',
    },
  ]);
  vi.mocked(api.getStatementMatches).mockResolvedValue([
    {
      id: 41,
      bankTransactionId: 11,
      status: 'active',
      amountMatched: 3500,
      objectLabel: 'Expense #61',
      counterpartyName: 'Elisa Eesti AS',
    },
  ]);
  vi.mocked(api.proposeMatches).mockResolvedValue([
    {
      bankTransactionId: 10,
      voucherId: 71,
      matchType: 'exact',
      amountMatched: 120000,
      confidence: 'high',
      signal: 'invoice_number',
      objectType: 'sales_invoice',
      objectId: 18,
      objectLabel: 'Invoice 2026-018',
      counterpartyName: 'Nordic Consulting OÜ',
      voucherRemaining: 120000,
    },
  ]);
}

describe('StatementScreen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStatementData();
  });

  it('shows the period title, segment counts, and the AI-proposals tier', async () => {
    renderAt();
    expect(await screen.findByText('Jun 2026')).toBeInTheDocument();
    expect(await screen.findByText('AI proposals')).toBeInTheDocument();
    expect(screen.getByText('Decide yourself')).toBeInTheDocument();
    expect(
      screen.getByRole('tab', { name: 'Unmatched 2' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'All 4' })).toBeInTheDocument();
    // The proposal-backed line sits in the AI-proposals tier (Task 7 upgrades
    // its row to the selectable ProposalRow with object label + confidence).
    expect(screen.getByText('NORDIC CONSULT')).toBeInTheDocument();
    // Matched line is hidden in the default Unmatched segment.
    expect(screen.queryByText('ELISA arve 6/2026')).toBeNull();
  });

  it('shows matched (green ✓, object label) and disposition rows in the All segment', async () => {
    renderAt('/bank/statements/3?seg=all');
    expect(await screen.findByText('ELISA arve 6/2026')).toBeInTheDocument();
    expect(screen.getByText(/→ Expense #61/)).toBeInTheDocument();
    expect(screen.getByText('personal')).toBeInTheDocument();
    expect(screen.getByText('Matched')).toBeInTheDocument();
  });

  it('navigates to the tx screen when a decide row is clicked', async () => {
    const router = renderAt();
    fireEvent.click(await screen.findByText('WOLT 220627'));
    expect(router.state.location.pathname).toBe('/bank/statements/3/tx/9');
  });

  it('deletes the statement behind an explicit confirm and returns to /bank', async () => {
    vi.mocked(api.deleteBankStatement).mockResolvedValue({ deleted: 3 });
    const router = renderAt();
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    fireEvent.click(
      await screen.findByRole('button', { name: 'Delete statement' }),
    );
    await vi.waitFor(() =>
      expect(api.deleteBankStatement).toHaveBeenCalledWith(3),
    );
    await vi.waitFor(() =>
      expect(router.state.location.pathname).toBe('/bank'),
    );
  });
});

describe('StatementScreen booking', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStatementData();
  });

  it('pre-selects high-confidence proposals and books them with an Undo toast', async () => {
    vi.mocked(api.executeMatches).mockResolvedValue({
      records: [{ id: 91 }],
      approvals: [{ id: 12, matchId: 91 }],
    });
    vi.mocked(api.approveApproval).mockResolvedValue({
      approval: { id: 12 },
    } as never);
    renderAt();
    // The single high-confidence proposal arrives pre-selected, with the
    // object label + confidence chip in the subtitle.
    const box = await screen.findByRole('checkbox', {
      name: /select match invoice 2026-018/i,
    });
    expect(box).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText(/Invoice 2026-018/)).toBeInTheDocument();
    expect(screen.getByText('high')).toBeInTheDocument();
    const bookBtn = screen.getByRole('button', { name: /book 1 match/i });
    fireEvent.click(bookBtn);
    await vi.waitFor(() => expect(api.executeMatches).toHaveBeenCalledOnce());
    expect(api.approveApproval).toHaveBeenCalledWith(12, 'operator');
    expect(await screen.findByText('Booked 1 match')).toBeInTheDocument();
    expect(
      await screen.findByRole('button', { name: 'Undo' }),
    ).toBeInTheDocument();
  });

  it('undo unmatches the booked matches', async () => {
    vi.mocked(api.executeMatches).mockResolvedValue({
      records: [{ id: 91 }],
      approvals: [{ id: 12, matchId: 91 }],
    });
    vi.mocked(api.approveApproval).mockResolvedValue({
      approval: { id: 12 },
    } as never);
    vi.mocked(api.unmatchMatch).mockResolvedValue({});
    renderAt();
    await screen.findByRole('checkbox', {
      name: /select match invoice 2026-018/i,
    });
    fireEvent.click(screen.getByRole('button', { name: /book 1 match/i }));
    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));
    await vi.waitFor(() =>
      expect(api.unmatchMatch).toHaveBeenCalledWith(3, 91),
    );
  });

  it('deselecting the proposal hides the Book bar', async () => {
    renderAt();
    const box = await screen.findByRole('checkbox', {
      name: /select match invoice 2026-018/i,
    });
    fireEvent.click(box);
    expect(box).toHaveAttribute('aria-checked', 'false');
    expect(screen.queryByRole('button', { name: /book/i })).toBeNull();
  });

  it('surfaces the server cap error text on booking failure', async () => {
    vi.mocked(api.executeMatches).mockRejectedValue(
      new Error('Match of 1200 would over-allocate bank line 10'),
    );
    renderAt();
    await screen.findByRole('checkbox', {
      name: /select match invoice 2026-018/i,
    });
    fireEvent.click(screen.getByRole('button', { name: /book 1 match/i }));
    expect(
      await screen.findByText(/would over-allocate bank line 10/),
    ).toBeInTheDocument();
  });

  it('renders a staged draft with a Confirm action that approves its approval', async () => {
    vi.mocked(api.getStatementMatches).mockResolvedValue([
      {
        id: 41,
        bankTransactionId: 11,
        status: 'active',
        amountMatched: 3500,
        objectLabel: 'Expense #61',
        counterpartyName: 'Elisa Eesti AS',
      },
      {
        id: 50,
        bankTransactionId: 9,
        status: 'draft',
        amountMatched: 1860,
        objectLabel: 'Expense #70',
        counterpartyName: null,
      },
    ]);
    vi.mocked(api.getPendingApprovals).mockResolvedValue([
      {
        id: 88,
        object_type: 'reconciliation_match',
        object_id: 50,
        status: 'pending',
        requested_by: 'system',
        approved_by: null,
        rejected_reason: null,
        policy_reason: null,
        superseded_by: null,
        created_at: 0,
        resolved_at: null,
      },
    ]);
    vi.mocked(api.approveApproval).mockResolvedValue({
      approval: { id: 88 },
    } as never);
    renderAt();
    expect(await screen.findByText('staged')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^confirm$/i }));
    await vi.waitFor(() =>
      expect(api.approveApproval).toHaveBeenCalledWith(88, 'operator'),
    );
  });
});
