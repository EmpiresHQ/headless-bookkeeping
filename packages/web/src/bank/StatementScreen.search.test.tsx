import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
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
  deleteBankStatement: vi.fn(),
}));

import * as api from '../api';
import type { MatchProposalView } from '../api';
import { StatementScreen } from './StatementScreen';
import { AppToaster } from '../ui/toast';
import { UnsavedChangesProvider } from '../lib/unsavedChanges';
import { ResultLogProvider } from '../lib/resultLog';

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
      <UnsavedChangesProvider onUnauthorized={() => undefined}>
        <ResultLogProvider>
          <RouterProvider router={router} />
          <AppToaster />
        </ResultLogProvider>
      </UnsavedChangesProvider>
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

const HIGH_PROPOSAL: MatchProposalView = {
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
};

/** A medium-confidence proposal (tx 9, WOLT −18.60) — must NOT preselect. */
const MEDIUM_PROPOSAL: MatchProposalView = {
  bankTransactionId: 9,
  voucherId: 55,
  matchType: 'exact',
  amountMatched: 1860,
  confidence: 'medium',
  signal: 'counterparty',
  objectType: 'expense',
  objectId: 77,
  objectLabel: 'Expense #77',
  counterpartyName: 'Wolt Eesti OÜ',
  voucherRemaining: 1860,
};

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
  vi.mocked(api.proposeMatches).mockResolvedValue([HIGH_PROPOSAL]);
}

/** A second HIGH proposal (tx 9, WOLT −18.60): preselected too. */
const HIGH_WOLT: MatchProposalView = {
  ...MEDIUM_PROPOSAL,
  confidence: 'high',
};

const searchBox = () =>
  screen.getByRole('searchbox', { name: 'Search this statement' });
const paramsOf = (router: ReturnType<typeof renderAt>) =>
  new URLSearchParams(router.state.location.search);

describe('StatementScreen search (issue #278)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStatementData();
  });

  it("narrows the lines by description, amount and date; counts stay the statement's", async () => {
    renderAt('/bank/statements/3?q=wolt');
    expect(await screen.findByText('WOLT 220627')).toBeInTheDocument();
    await screen.findByText(/Showing 1 of 2 lines/);
    expect(screen.queryByText('NORDIC CONSULT')).toBeNull();
    expect(
      screen.getByRole('tab', { name: 'Unmatched 2' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'All 4' })).toBeInTheDocument();
    fireEvent.change(searchBox(), { target: { value: '1200' } });
    expect(await screen.findByText('NORDIC CONSULT')).toBeInTheDocument();
    expect(screen.queryByText('WOLT 220627')).toBeNull();
    fireEvent.change(searchBox(), { target: { value: '27 jun' } });
    expect(await screen.findByText('WOLT 220627')).toBeInTheDocument();
    expect(screen.queryByText('NORDIC CONSULT')).toBeNull();
    // A proposal's target document.
    fireEvent.change(searchBox(), { target: { value: 'invoice 2026-018' } });
    expect(await screen.findByText('NORDIC CONSULT')).toBeInTheDocument();
  });

  it('matched lines are searched in All (by their matched document); Unmatched says where they are', async () => {
    const router = renderAt('/bank/statements/3?q=elisa%20eesti');
    expect(await screen.findByText('No lines match')).toBeInTheDocument();
    expect(screen.getByText(/Matched lines are under All/)).toBeInTheDocument();
    expect(screen.queryByText('All lines reconciled')).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'All 4' }));
    expect(await screen.findByText('ELISA arve 6/2026')).toBeInTheDocument();
    expect(paramsOf(router).get('q')).toBe('elisa eesti');
    expect(paramsOf(router).get('seg')).toBe('all');
  });

  it('segment switches keep ?q=, unrelated params and the entry state (replace)', async () => {
    const router = renderAt('/bank/statements/3');
    const origin = {
      hbkOrigin: { href: '/bank', state: null, idx: 0, key: 'k' },
    };
    await act(() =>
      router.navigate('/bank/statements/3?q=wolt&keep=1', {
        replace: true,
        state: origin,
      }),
    );
    fireEvent.click(await screen.findByRole('tab', { name: 'All 4' }));
    await waitFor(() => expect(paramsOf(router).get('seg')).toBe('all'));
    expect(paramsOf(router).get('q')).toBe('wolt');
    expect(paramsOf(router).get('keep')).toBe('1');
    expect(router.state.historyAction).toBe('REPLACE');
    expect(router.state.location.state).toEqual(origin);
    fireEvent.click(screen.getByRole('tab', { name: 'Unmatched 2' }));
    await waitFor(() => expect(paramsOf(router).get('seg')).toBeNull());
    expect(paramsOf(router).get('q')).toBe('wolt');
    expect(paramsOf(router).get('keep')).toBe('1');
    expect(router.state.location.state).toEqual(origin);
  });

  it('a hidden preselected high-confidence proposal is never booked; Clear brings it back', async () => {
    vi.mocked(api.proposeMatches).mockResolvedValue([HIGH_PROPOSAL, HIGH_WOLT]);
    vi.mocked(api.executeMatches).mockResolvedValue({
      records: [{ id: 91 }],
      approvals: [{ id: 12, matchId: 91 }],
    });
    vi.mocked(api.approveApproval).mockResolvedValue({
      approval: { id: 12 },
    } as never);
    const router = renderAt('/bank/statements/3');
    // Unfiltered: both high-confidence proposals are preselected.
    expect(
      await screen.findByRole('button', { name: /book 2 matches/i }),
    ).toBeInTheDocument();
    fireEvent.change(searchBox(), { target: { value: 'nordic' } });
    const book = await screen.findByRole('button', {
      name: /book 1 shown match/i,
    });
    expect(book).toHaveTextContent('+1200.00 € net');
    expect(
      screen.getByText(
        /1 selected match is hidden by the search and will not be booked/,
      ),
    ).toBeInTheDocument();
    // Clear restores the hidden selection untouched.
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    await waitFor(() => expect(paramsOf(router).get('q')).toBeNull());
    expect(
      await screen.findByRole('button', { name: /book 2 matches/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('checkbox', { name: /select match expense #77/i }),
    ).toHaveAttribute('aria-checked', 'true');
    await waitFor(() => expect(searchBox()).toHaveFocus());
    // Search again and book: exactly the shown proposal goes to the server.
    fireEvent.change(searchBox(), { target: { value: 'nordic' } });
    fireEvent.click(
      await screen.findByRole('button', { name: /book 1 shown match/i }),
    );
    await waitFor(() => expect(api.executeMatches).toHaveBeenCalledOnce());
    expect(api.executeMatches).toHaveBeenCalledWith(3, [HIGH_PROPOSAL]);
    expect(await screen.findByText('Booked 1 match')).toBeInTheDocument();
  });

  it.each([
    ['without a search', '/bank/statements/3'],
    ['with a search', '/bank/statements/3?q=nordic'],
  ])(
    'a cached proposal on a line booked meanwhile is never "hidden by the search" (%s)',
    async (_label, path) => {
      vi.mocked(api.executeMatches).mockImplementation(async () => {
        // After booking: the line is matched, the proposals refresh fails
        // and the cached (now stale) proposal stays.
        vi.mocked(api.getReconciliationStatus).mockResolvedValue([
          {
            bankTransactionId: 10,
            amountBase: 120000,
            matchedSum: 120000,
            remaining: 0,
            reconStatus: 'matched',
          },
        ]);
        vi.mocked(api.getStatementMatches).mockResolvedValue([
          {
            id: 91,
            bankTransactionId: 10,
            status: 'active',
            amountMatched: 120000,
            objectLabel: 'Invoice 2026-018',
            counterpartyName: 'Nordic Consulting OÜ',
          },
        ]);
        vi.mocked(api.proposeMatches).mockRejectedValue(
          new Error('proposals down'),
        );
        return {
          records: [{ id: 91 }],
          approvals: [{ id: 12, matchId: 91 }],
        };
      });
      vi.mocked(api.approveApproval).mockResolvedValue({
        approval: { id: 12 },
      } as never);
      renderAt(path);
      fireEvent.click(await screen.findByRole('button', { name: /^book 1/i }));
      expect(await screen.findByText('Booked 1 match')).toBeInTheDocument();
      expect(
        await screen.findByText("Couldn't load AI proposals"),
      ).toBeInTheDocument();
      expect(screen.queryByText(/hidden by the search/)).toBeNull();
      expect(screen.queryByRole('button', { name: /^book \d/i })).toBeNull();
      expect(api.executeMatches).toHaveBeenCalledOnce();
    },
  );

  it('only hidden selections: no Book button, and the screen says how to book them', async () => {
    vi.mocked(api.proposeMatches).mockResolvedValue([HIGH_PROPOSAL]);
    renderAt('/bank/statements/3?q=wolt');
    expect(await screen.findByText('WOLT 220627')).toBeInTheDocument();
    expect(
      await screen.findByText(
        /1 selected match is hidden by the search — clear it to book it/,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^book/i })).toBeNull();
  });

  it('while a booking is pending: search, Clear and segments are locked and the Book figures stay the request', async () => {
    vi.mocked(api.proposeMatches).mockResolvedValue([
      HIGH_PROPOSAL,
      {
        ...HIGH_WOLT,
        bankTransactionId: 10,
        voucherId: 72,
        objectLabel: 'Expense #78',
      },
    ]);
    let release: (v: unknown) => void = () => undefined;
    vi.mocked(api.executeMatches).mockReturnValue(
      new Promise((r) => {
        release = r;
      }) as never,
    );
    vi.mocked(api.approveApproval).mockResolvedValue({
      approval: { id: 12 },
    } as never);
    const router = renderAt('/bank/statements/3?q=nordic');
    const book = await screen.findByRole('button', {
      name: /book 2 shown matches/i,
    });
    fireEvent.click(book);
    await waitFor(() => expect(api.executeMatches).toHaveBeenCalledOnce());
    const sent = vi.mocked(api.executeMatches).mock.calls[0][1];
    expect(sent).toHaveLength(2);
    expect(searchBox()).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Clear search' })).toBeDisabled();
    expect(screen.getByRole('tab', { name: 'All 4' })).toBeDisabled();
    fireEvent.click(screen.getByRole('tab', { name: 'All 4' }));
    expect(paramsOf(router).get('seg')).toBeNull();
    // Deselecting a row mid-flight does not rewrite the pending button.
    fireEvent.click(
      screen.getByRole('checkbox', { name: /select match expense #78/i }),
    );
    expect(
      screen.getByRole('button', { name: /book 2 shown matches/i }),
    ).toBeDisabled();
    expect(api.executeMatches).toHaveBeenCalledOnce();
    release({
      records: [{ id: 91 }, { id: 92 }],
      approvals: [
        { id: 12, matchId: 91 },
        { id: 13, matchId: 92 },
      ],
    });
    expect(await screen.findByText('Booked 2 matches')).toBeInTheDocument();
    await waitFor(() => expect(searchBox()).not.toBeDisabled());
    expect(api.executeMatches).toHaveBeenCalledWith(3, sent);
  });
});
