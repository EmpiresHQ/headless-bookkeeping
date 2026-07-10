import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
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
  onboardEntity: vi.fn(),
  addEntityAlias: vi.fn(),
  markPersonal: vi.fn(),
  createPrepayment: vi.fn(),
}));

import * as api from '../api';
import { AppToaster } from '../ui/toast';
import { TxScreen } from './TxScreen';

const BASE_TX = {
  id: 9,
  transaction_date: '2026-06-27',
  description: 'WOLT 220627',
  amount: -1860,
  currency: 'EUR',
  counterparty_iban: null,
  counterparty_descriptor: null,
  reference: null,
  status: 'open',
};

function mockLine(
  over: Partial<typeof BASE_TX> = {},
  extra?: {
    matches?: unknown[];
    candidates?: unknown[];
    proposals?: unknown[];
  },
) {
  const tx = { ...BASE_TX, ...over };
  vi.mocked(api.listBankTransactions).mockResolvedValue([tx] as never);
  vi.mocked(api.getReconciliationStatus).mockResolvedValue([
    {
      bankTransactionId: 9,
      amountBase: Math.abs(tx.amount),
      matchedSum: 0,
      remaining: Math.abs(tx.amount),
      reconStatus: 'open',
    },
  ]);
  vi.mocked(api.getStatementMatches).mockResolvedValue(
    (extra?.matches ?? []) as never,
  );
  vi.mocked(api.getMatchCandidates).mockResolvedValue({
    bankTransactionId: 9,
    lineRemaining: Math.abs(tx.amount),
    candidates: (extra?.candidates ?? []) as never,
  });
  vi.mocked(api.proposeMatches).mockResolvedValue(
    (extra?.proposals ?? []) as never,
  );
  vi.mocked(api.getCategories).mockResolvedValue([
    { key: 'meals', label: 'Meals', accountCode: 'EXPENSE_MEALS' },
    { key: 'bank fee', label: 'Bank Fee', accountCode: 'EXPENSE_BANK_FEE' },
  ]);
  vi.mocked(api.getEntities).mockResolvedValue([]);
  vi.mocked(api.getOrganization).mockResolvedValue({
    id: 1,
    country: 'EE',
    base_currency: 'EUR',
    vat_registered: true,
    org_type: 'company',
    created_at: 0,
    name: null,
    vat_registration_number: null,
    iban: null,
  });
}

function renderTx(path = '/bank/statements/3/tx/9') {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const router = createMemoryRouter(
    [
      { path: '/bank/statements/:id', element: <p>statement screen</p> },
      { path: '/bank/statements/:id/tx/:txId', element: <TxScreen /> },
    ],
    { initialEntries: [path] },
  );
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
      <AppToaster />
    </QueryClientProvider>,
  );
  return router;
}

describe('TxScreen state composition', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders the hero as a fact and the create state for an outgoing line with no candidates', async () => {
    mockLine();
    renderTx();
    expect(await screen.findByText('−18.60 €')).toBeInTheDocument();
    expect(
      await screen.findByText('Create expense from line'),
    ).toBeInTheDocument();
    expect(screen.getByText('1 unmatched')).toBeInTheDocument();
    // Alternatives are reachable but not the accent.
    expect(
      screen.getByText(/Personal · Bank fee · Prepayment/),
    ).toBeInTheDocument();
  });

  it('renders the matched state (G) when the line has matches', async () => {
    mockLine(
      {},
      {
        matches: [
          {
            id: 41,
            bankTransactionId: 9,
            status: 'active',
            amountMatched: 1860,
            objectLabel: 'Expense #55',
            counterpartyName: 'Wolt Eesti OÜ',
          },
        ],
      },
    );
    renderTx();
    expect(await screen.findByText('Matched with')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Unmatch' })).toBeInTheDocument();
  });

  it('renders the candidates state (C) and returns to the statement with an Undo toast after matching', async () => {
    mockLine(
      { amount: 50000, description: 'ETTEMAKS Baltic Trade' },
      {
        candidates: [
          {
            voucherId: 70,
            objectType: 'sales_invoice',
            objectId: 14,
            objectLabel: 'Invoice 2026-014',
            counterpartyName: 'Baltic Trade OÜ',
            voucherRemaining: 30000,
          },
        ],
        proposals: [
          {
            bankTransactionId: 9,
            voucherId: 70,
            matchType: 'partial',
            amountMatched: 30000,
            confidence: 'high',
            signal: 'counterparty',
            objectType: 'sales_invoice',
            objectId: 14,
            objectLabel: 'Invoice 2026-014',
            counterpartyName: 'Baltic Trade OÜ',
            voucherRemaining: 30000,
          },
        ],
      },
    );
    vi.mocked(api.manualMatch).mockResolvedValue({
      records: [{ id: 91 }],
      approvals: [{ id: 12, matchId: 91 }],
    });
    vi.mocked(api.approveApproval).mockResolvedValue({ approval: {} } as never);
    const router = renderTx();
    // Proposal-backed candidate is preselected → button ready.
    fireEvent.click(
      await screen.findByRole('button', { name: 'Match 300.00 €' }),
    );
    await vi.waitFor(() =>
      expect(router.state.location.pathname).toBe('/bank/statements/3'),
    );
    expect(await screen.findByText('Matched · 300.00 €')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
  });

  it('renders the incoming-open state with a prepayment primary', async () => {
    mockLine({ amount: 50000, description: 'ETTEMAKS Baltic Trade' });
    renderTx();
    expect(
      await screen.findByRole('button', {
        name: 'Record prepayment · +500.00 €',
      }),
    ).toBeInTheDocument();
  });

  it('personal flows through the explanation sheet and calls markPersonal', async () => {
    mockLine();
    vi.mocked(api.markPersonal).mockResolvedValue({});
    const router = renderTx();
    fireEvent.click(
      await screen.findByText(/Personal · Bank fee · Prepayment/),
    );
    fireEvent.click(await screen.findByText('Personal'));
    // The consequences sheet is the explicit confirm step.
    expect(
      await screen.findByText(/not a company expense/i),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Record as personal' }));
    await vi.waitFor(() => expect(api.markPersonal).toHaveBeenCalledWith(9));
    await vi.waitFor(() =>
      expect(router.state.location.pathname).toBe('/bank/statements/3'),
    );
  });

  it('bank fee composes a VAT-0 bank-fee expense and matches it', async () => {
    mockLine({ amount: -800, description: 'SEB hooldustasu' });
    vi.mocked(api.createExpense).mockResolvedValue({ id: 60 } as never);
    vi.mocked(api.postExpense).mockResolvedValue({
      expense: { id: 60, status: 'posted' },
      policy: { action: 'auto-post', reason: 'ok' },
    } as never);
    vi.mocked(api.getMatchCandidates)
      .mockResolvedValueOnce({
        bankTransactionId: 9,
        lineRemaining: 800,
        candidates: [],
      }) // state routing
      .mockResolvedValue({
        bankTransactionId: 9,
        lineRemaining: 800,
        candidates: [
          {
            voucherId: 80,
            objectType: 'expense',
            objectId: 60,
            objectLabel: 'Expense #60',
            counterpartyName: null,
            voucherRemaining: 800,
          },
        ],
      });
    vi.mocked(api.manualMatch).mockResolvedValue({
      records: [{ id: 95 }],
      approvals: [{ id: 15, matchId: 95 }],
    });
    vi.mocked(api.approveApproval).mockResolvedValue({ approval: {} } as never);
    renderTx();
    fireEvent.click(
      await screen.findByText(/Personal · Bank fee · Prepayment/),
    );
    fireEvent.click(await screen.findByText('Bank fee'));
    await vi.waitFor(() =>
      expect(api.createExpense).toHaveBeenCalledWith({
        category: 'bank fee',
        gross_amount: 800,
        vat_amount: 0,
        currency: 'EUR',
        tax_point_date: '2026-06-27',
        supplier_id: null,
      }),
    );
  });

  it('unmounts the create form on done — a second click cannot post a duplicate', async () => {
    mockLine();
    // Pin the createDone guard, not navigation: the tx refetch triggered by
    // onDone's invalidateStatement hangs, so `navigate` never fires. The ONLY
    // thing that can remove the submit button is the guard's own unmount —
    // without it, the button re-enables in the done-window and stays.
    vi.mocked(api.listBankTransactions)
      .mockReset()
      .mockResolvedValueOnce([BASE_TX] as never)
      .mockImplementation(() => new Promise(() => {}));
    vi.mocked(api.createExpense).mockResolvedValue({ id: 55 } as never);
    vi.mocked(api.postExpense).mockResolvedValue({
      expense: { id: 55, status: 'posted' },
      policy: { action: 'auto-post', reason: 'ok' },
    } as never);
    const noCandidates = {
      bankTransactionId: 9,
      lineRemaining: 1860,
      candidates: [],
    };
    vi.mocked(api.getMatchCandidates)
      .mockResolvedValueOnce(noCandidates) // state routing on mount
      .mockResolvedValueOnce({
        // the composite's own lookup of the fresh expense
        bankTransactionId: 9,
        lineRemaining: 1860,
        candidates: [
          {
            voucherId: 70,
            objectType: 'expense',
            objectId: 55,
            objectLabel: 'Expense #55',
            counterpartyName: null,
            voucherRemaining: 1860,
          },
        ],
      })
      .mockResolvedValue(noCandidates); // invalidation refetch → still 'create'
    vi.mocked(api.manualMatch).mockResolvedValue({
      records: [{ id: 88 }],
      approvals: [{ id: 12, matchId: 88 }],
    });
    vi.mocked(api.approveApproval).mockResolvedValue({ approval: {} } as never);
    const router = renderTx();
    await screen.findByText('Meals');
    fireEvent.change(screen.getByLabelText('Category'), {
      target: { value: 'meals' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Create & match · −18.60 €' }),
    );
    // The success toast renders in the same batched flush as the form's own
    // setBusy(false) — the exact moment the done-window would open. (Waiting
    // on the button's name alone is not a sync point: while busy it renders
    // '…', so its accessible name never matches mid-flight.)
    await screen.findByText('Expense created & matched · −18.60 €');
    // Guard: the form unmounted in that same flush. Without the guard the
    // button would be back — enabled — and a second tap would post a
    // duplicate expense.
    expect(
      screen.queryByRole('button', { name: 'Create & match · −18.60 €' }),
    ).toBeNull();
    // ...and it vanished BEFORE navigation — the guard, not the redirect.
    expect(router.state.location.pathname).toBe('/bank/statements/3/tx/9');
    expect(api.createExpense).toHaveBeenCalledTimes(1);
  });

  it('prepayment confirms through the explanation sheet and calls createPrepayment', async () => {
    mockLine({ amount: 50000, description: 'ETTEMAKS Baltic Trade' });
    vi.mocked(api.createPrepayment).mockResolvedValue({} as never);
    const router = renderTx();
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Record prepayment · +500.00 €',
      }),
    );
    // The explanation sheet is the explicit confirm step.
    expect(
      await screen.findByText(/money received on account/),
    ).toBeInTheDocument();
    const confirms = screen.getAllByRole('button', {
      name: 'Record prepayment · +500.00 €',
    });
    fireEvent.click(confirms[confirms.length - 1]);
    await vi.waitFor(() =>
      expect(api.createPrepayment).toHaveBeenCalledWith(9),
    );
    await vi.waitFor(() =>
      expect(router.state.location.pathname).toBe('/bank/statements/3'),
    );
  });

  it('renders the disposed state read-only', async () => {
    mockLine({ status: 'personal' });
    renderTx();
    expect(await screen.findByText('Recorded as personal')).toBeInTheDocument();
    expect(screen.queryByText('Create expense from line')).toBeNull();
  });

  it('renders LoadError when the transactions query fails, with a working retry', async () => {
    mockLine();
    vi.mocked(api.listBankTransactions)
      .mockReset()
      .mockRejectedValueOnce(new Error('Network down'))
      .mockResolvedValue([BASE_TX] as never);
    renderTx();
    expect(await screen.findByText('Network down')).toBeInTheDocument();
    expect(
      screen.queryByText('Create expense from line'),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await vi.waitFor(() =>
      expect(api.listBankTransactions).toHaveBeenCalledTimes(2),
    );
    // Recovers into the normal (create) state once the retry succeeds.
    expect(
      await screen.findByText('Create expense from line'),
    ).toBeInTheDocument();
  });

  it('renders a not-found state for an unknown txId deep link, with a link back to the statement', async () => {
    mockLine();
    const router = renderTx('/bank/statements/3/tx/999');
    expect(await screen.findByText('Line not found')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('link', { name: 'Back to statement' }));
    expect(router.state.location.pathname).toBe('/bank/statements/3');
  });

  it('carries ?seg=all through the back link (round trip from the statement)', async () => {
    mockLine();
    renderTx('/bank/statements/3/tx/9?seg=all');
    const backLink = await screen.findByRole('link', { name: '‹ Back' });
    expect(backLink).toHaveAttribute('href', '/bank/statements/3?seg=all');
  });
});
