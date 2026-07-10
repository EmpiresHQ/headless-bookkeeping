import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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

  it('carries ?seg=all into the tx URL when a line is opened from the All segment', async () => {
    const router = renderAt('/bank/statements/3?seg=all');
    fireEvent.click(await screen.findByText('ELISA arve 6/2026'));
    expect(router.state.location.pathname).toBe('/bank/statements/3/tx/11');
    expect(router.state.location.search).toBe('?seg=all');
  });

  it('does not append ?seg= for the default Unmatched segment', async () => {
    const router = renderAt();
    fireEvent.click(await screen.findByText('WOLT 220627'));
    expect(router.state.location.pathname).toBe('/bank/statements/3/tx/9');
    expect(router.state.location.search).toBe('');
  });

  it('shows LoadError when the reconciliation or matches query fails, gating the worklist', async () => {
    vi.mocked(api.getReconciliationStatus).mockRejectedValue(
      new Error('recon endpoint down'),
    );
    renderAt();
    expect(await screen.findByText('recon endpoint down')).toBeInTheDocument();
    // The (misleading) "Decide yourself" worklist must not render on top of
    // an error — matched lines must not silently dump in there.
    expect(screen.queryByText('Decide yourself')).toBeNull();
  });

  it('shows a non-blocking inline notice when AI proposals fail to load, without blocking the rest of the screen', async () => {
    vi.mocked(api.proposeMatches).mockRejectedValue(
      new Error('proposals endpoint down'),
    );
    renderAt();
    expect(
      await screen.findByText("Couldn't load AI proposals"),
    ).toBeInTheDocument();
    // Non-blocking: the rest of the worklist still renders.
    expect(screen.getByText('Decide yourself')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await vi.waitFor(() => expect(api.proposeMatches).toHaveBeenCalledTimes(2));
  });

  it('deletes the statement behind an explicit confirm and returns to /bank', async () => {
    vi.mocked(api.deleteBankStatement).mockResolvedValue({ deleted: 3 });
    const router = renderAt();
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    fireEvent.click(
      await screen.findByRole('button', { name: 'Delete statement' }),
    );
    await waitFor(() =>
      expect(api.deleteBankStatement).toHaveBeenCalledWith(3),
    );
    await waitFor(() => expect(router.state.location.pathname).toBe('/bank'));
    // Settle point: `router.state.location.pathname` flips before
    // RouterProvider actually commits the route swap, so StatementScreen
    // (and its still-`open` Radix ConfirmDialog) unmounts on a later tick.
    // Wait for the destination route's own content so that unmount, and
    // the dialog's exit-animation/focus-release effects, land inside act().
    await screen.findByText('bank list');
  });

  it('fans out delete-statement invalidation to expenses/books/reports (unlinked matches un-reconcile expenses)', async () => {
    vi.mocked(api.deleteBankStatement).mockResolvedValue({ deleted: 3 });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries');
    const router = createMemoryRouter(
      [
        { path: '/bank', element: <p>bank list</p> },
        { path: '/bank/statements/:id', element: <StatementScreen /> },
      ],
      { initialEntries: ['/bank/statements/3'] },
    );
    render(
      <QueryClientProvider client={client}>
        <>
          <RouterProvider router={router} />
          <AppToaster />
        </>
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    fireEvent.click(
      await screen.findByRole('button', { name: 'Delete statement' }),
    );
    await waitFor(() =>
      expect(api.deleteBankStatement).toHaveBeenCalledWith(3),
    );
    await waitFor(() => expect(router.state.location.pathname).toBe('/bank'));
    const invalidatedKeys = invalidateSpy.mock.calls.map(
      (c) => (c[0] as { queryKey: unknown[] }).queryKey,
    );
    expect(invalidatedKeys).toContainEqual(['bank', 'statements']);
    expect(invalidatedKeys).toContainEqual(['expenses']);
    expect(invalidatedKeys).toContainEqual(['books']);
    expect(invalidatedKeys).toContainEqual(['reports']);
    // Settle point: `router.state.location.pathname` flips before
    // RouterProvider actually commits the route swap, so StatementScreen
    // (and its still-`open` Radix ConfirmDialog) unmounts on a later tick —
    // that unmount is where the fan-out invalidateQueries calls above and
    // the dialog's exit-animation/focus-release effects actually settle.
    // Wait for the invalidate count to reach its final total and for the
    // destination route's own content so those updates land inside act().
    await waitFor(() => expect(invalidateSpy).toHaveBeenCalledTimes(5));
    await screen.findByText('bank list');
  });
});

describe('StatementScreen booking', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStatementData();
  });

  it('pre-selects ONLY high-confidence proposals and books exactly the selected set with an Undo toast', async () => {
    // A medium-confidence proposal alongside the high one: it must render
    // unselected, stay out of the Book payload, and not count toward the net.
    vi.mocked(api.proposeMatches).mockResolvedValue([
      HIGH_PROPOSAL,
      MEDIUM_PROPOSAL,
    ]);
    vi.mocked(api.executeMatches).mockResolvedValue({
      records: [{ id: 91 }],
      approvals: [{ id: 12, matchId: 91 }],
    });
    vi.mocked(api.approveApproval).mockResolvedValue({
      approval: { id: 12 },
    } as never);
    renderAt();
    // The high-confidence proposal arrives pre-selected, with the object
    // label + confidence chip in the subtitle.
    const box = await screen.findByRole('checkbox', {
      name: /select match invoice 2026-018/i,
    });
    expect(box).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText(/Invoice 2026-018/)).toBeInTheDocument();
    expect(screen.getByText('high')).toBeInTheDocument();
    // The medium-confidence proposal is NOT preselected.
    const mediumBox = screen.getByRole('checkbox', {
      name: /select match expense #77/i,
    });
    expect(mediumBox).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText('medium')).toBeInTheDocument();
    // Book bar: only the selected proposal counts — signed net is the high
    // proposal's +1200.00, not 1200.00 − 18.60.
    const bookBtn = screen.getByRole('button', { name: /book 1 match/i });
    expect(bookBtn).toHaveTextContent('+1200.00 € net');
    fireEvent.click(bookBtn);
    await vi.waitFor(() => expect(api.executeMatches).toHaveBeenCalledOnce());
    // Exactly the chosen proposal objects go to the server — nothing more.
    expect(api.executeMatches).toHaveBeenCalledWith(3, [HIGH_PROPOSAL]);
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

  it('keeps manual deselections across refetches (preselect fires once per statement)', async () => {
    // Confirm on a staged row invalidates the statement; the proposals
    // refetch (here returning a changed set) must NOT resurrect a proposal
    // the operator deselected — the Book count is a money-moving control.
    vi.mocked(api.proposeMatches)
      .mockResolvedValueOnce([HIGH_PROPOSAL, MEDIUM_PROPOSAL])
      .mockResolvedValue([HIGH_PROPOSAL]);
    vi.mocked(api.getStatementMatches).mockResolvedValue([
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
    const box = await screen.findByRole('checkbox', {
      name: /select match invoice 2026-018/i,
    });
    fireEvent.click(box); // operator deselects the preselected proposal
    expect(box).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(screen.getByRole('button', { name: /^confirm$/i }));
    await vi.waitFor(() =>
      expect(api.approveApproval).toHaveBeenCalledWith(88, 'operator'),
    );
    // Invalidation refetched proposals with a new data reference…
    await vi.waitFor(() => expect(api.proposeMatches).toHaveBeenCalledTimes(2));
    // …and the deselection survived: still unchecked, no Book bar.
    const boxAfter = await screen.findByRole('checkbox', {
      name: /select match invoice 2026-018/i,
    });
    expect(boxAfter).toHaveAttribute('aria-checked', 'false');
    expect(screen.queryByRole('button', { name: /book/i })).toBeNull();
  });

  it('surfaces a partial booking failure (staged vs activated) without offering Undo, and refetches', async () => {
    // Two matches staged; the second approval fails at activation — money is
    // half-moved. The UI must state what activated vs what is left staged,
    // must NOT offer Undo, and must refetch so drafts stay visible.
    vi.mocked(api.executeMatches).mockResolvedValue({
      records: [{ id: 91 }, { id: 92 }],
      approvals: [
        { id: 12, matchId: 91 },
        { id: 13, matchId: 92 },
      ],
    });
    vi.mocked(api.approveApproval)
      .mockResolvedValueOnce({ approval: { id: 12 } } as never)
      .mockRejectedValueOnce(
        new Error('Match of 1860 would over-allocate bank line 9'),
      );
    renderAt();
    await screen.findByRole('checkbox', {
      name: /select match invoice 2026-018/i,
    });
    const matchesCallsBefore = vi.mocked(api.getStatementMatches).mock.calls
      .length;
    fireEvent.click(screen.getByRole('button', { name: /book 1 match/i }));
    // BookingPartialError's message pins activated-vs-staged and the cause.
    expect(
      await screen.findByText(
        /approval 13 failed \(1\/2 activated\): Match of 1860 would over-allocate bank line 9/,
      ),
    ).toBeInTheDocument();
    // A half-moved booking must not offer a one-click Undo.
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
    // The invalidation path ran: statement queries refetch so the leftover
    // draft renders as staged (with its Confirm recovery button).
    await vi.waitFor(() =>
      expect(
        vi.mocked(api.getStatementMatches).mock.calls.length,
      ).toBeGreaterThan(matchesCallsBefore),
    );
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
