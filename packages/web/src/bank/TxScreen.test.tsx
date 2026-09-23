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
  onboardEntity: vi.fn(),
  addEntityAlias: vi.fn(),
  markPersonal: vi.fn(),
  createPrepayment: vi.fn(),
  getAdvanceVatTreatments: vi.fn(),
}));

import * as api from '../api';
import { AppToaster } from '../ui/toast';
import { TxScreen } from './TxScreen';
import { UnsavedChangesProvider } from '../lib/unsavedChanges';

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
  vi.mocked(api.getAdvanceVatTreatments).mockResolvedValue([
    { vat_code: 'EE_OUTPUT_24', rate_permille: 240 },
  ]);
  vi.mocked(api.getOrganization).mockResolvedValue({
    id: 1,
    country: 'EE',
    base_currency: 'EUR',
    vat_registered: true,
    vat_registration_kind: 'ordinary',
    input_vat_entitlement: 'full',
    input_vat_deduction_permille: null,
    org_type: 'company',
    created_at: 0,
    name: null,
    registry_code: null,
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
      <UnsavedChangesProvider onUnauthorized={() => undefined}>
        <RouterProvider router={router} />
        <AppToaster />
      </UnsavedChangesProvider>
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
    await waitFor(() =>
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
    await waitFor(() => expect(api.markPersonal).toHaveBeenCalledWith(9));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/bank/statements/3'),
    );
  });

  it('bank fee composes a VAT-0 bank-fee expense and matches it', async () => {
    mockLine({ amount: -800, description: 'SEB hooldustasu' });
    vi.mocked(api.postExpense).mockResolvedValue({
      expense: { id: 60, status: 'posted' },
      policy: { action: 'auto-post', reason: 'ok' },
    } as never);
    // Order-decoupled: the candidate appears the moment the expense is
    // CREATED (the mutation that causes it), not on "the second call".
    const feeCandidate = {
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
    };
    let candidates: typeof feeCandidate = {
      bankTransactionId: 9,
      lineRemaining: 800,
      candidates: [],
    };
    vi.mocked(api.getMatchCandidates).mockImplementation(() =>
      Promise.resolve(candidates as never),
    );
    vi.mocked(api.createExpense).mockImplementation(async () => {
      candidates = feeCandidate; // the create is what makes it findable
      return { id: 60 } as never;
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
    await waitFor(() =>
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

  it('keeps the line protected until the awaited refresh settles — no duplicate, then one success (#251)', async () => {
    mockLine();
    // The statement refresh is part of the operation (issue #251): while
    // the tx-list refetch it triggers is held, the operation is still in
    // flight — the form stays locked and a second submit cannot start. Its
    // release then runs the success continuation exactly once, from
    // TxScreen (which owns the operation and stays mounted even though the
    // refresh re-routes the line).
    // Phase-encoded mocks: the tx list resolves once (mount) and then hangs
    // (the invalidation refetch that must NOT be the thing that removes the
    // button); candidates flip on the mutations that cause them — fresh
    // expense appears on createExpense, disappears again when manualMatch
    // consumes it — so an extra refetch can never shift the script.
    const noCandidates = {
      bankTransactionId: 9,
      lineRemaining: 1860,
      candidates: [],
    };
    const freshExpense = {
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
    };
    let txListServed = false;
    let releaseRefetch: () => void = () => undefined;
    vi.mocked(api.listBankTransactions)
      .mockReset()
      .mockImplementation(() => {
        if (!txListServed) {
          txListServed = true;
          return Promise.resolve([BASE_TX] as never);
        }
        return new Promise((resolve) => {
          releaseRefetch = () => resolve([BASE_TX] as never);
        });
      });
    let candidates: typeof freshExpense = noCandidates;
    vi.mocked(api.getMatchCandidates).mockImplementation(() =>
      Promise.resolve(candidates as never),
    );
    vi.mocked(api.createExpense).mockImplementation(async () => {
      candidates = freshExpense;
      return { id: 55 } as never;
    });
    vi.mocked(api.postExpense).mockResolvedValue({
      expense: { id: 55, status: 'posted' },
      policy: { action: 'auto-post', reason: 'ok' },
    } as never);
    vi.mocked(api.manualMatch).mockImplementation(async () => {
      candidates = noCandidates; // consumed — refetches route back to 'create'
      return { records: [{ id: 88 }], approvals: [{ id: 12, matchId: 88 }] };
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
    // Every API stage landed; only the refresh is outstanding.
    await waitFor(() => expect(api.approveApproval).toHaveBeenCalledTimes(1));
    // Busy (#281): the primary keeps its operation name but is locked.
    const primary = screen.getByRole('button', {
      name: 'Create & match · −18.60 €',
    });
    expect(primary).toBeDisabled();
    expect(primary).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('status')).toHaveTextContent(/locked/);
    expect(
      screen.queryByText('Expense created & matched · −18.60 €'),
    ).toBeNull();
    expect(router.state.location.pathname).toBe('/bank/statements/3/tx/9');

    await act(async () => releaseRefetch());
    await screen.findByText('Expense created & matched · −18.60 €');
    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/bank/statements/3'),
    );
    expect(api.createExpense).toHaveBeenCalledTimes(1);
    expect(api.postExpense).toHaveBeenCalledTimes(1);
    expect(api.manualMatch).toHaveBeenCalledTimes(1);
  });

  it('holds an incoming prepayment nobody classified, and says so (#213)', async () => {
    mockLine({ amount: 50000, description: 'ETTEMAKS Baltic Trade' });
    vi.mocked(api.createPrepayment).mockResolvedValue({} as never);
    const router = renderTx();
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Record prepayment · +500.00 €',
      }),
    );
    // The sheet asks what the money is, and defaults to no claim at all.
    expect(await screen.findByText('What is this money?')).toBeInTheDocument();
    expect(screen.getByText(/cannot settle an invoice/)).toBeInTheDocument();

    const confirms = screen.getAllByRole('button', {
      name: 'Record prepayment · +500.00 €',
    });
    fireEvent.click(confirms[confirms.length - 1]);
    // No treatment is sent: the receipt is recorded and HELD server-side.
    await waitFor(() =>
      expect(api.createPrepayment).toHaveBeenCalledWith(9, undefined),
    );
    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/bank/statements/3'),
    );
  });

  it('sends the taxable advance facts when the receipt pays for a supply (#213)', async () => {
    mockLine({ amount: 12400, description: 'ETTEMAKS Baltic Trade' });
    vi.mocked(api.createPrepayment).mockResolvedValue({} as never);
    vi.mocked(api.getAdvanceVatTreatments).mockResolvedValue([
      { vat_code: 'EE_OUTPUT_24', rate_permille: 240 },
      { vat_code: 'EE_OUTPUT_9', rate_permille: 90 },
    ]);
    renderTx();
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Record prepayment · +124.00 €',
      }),
    );
    fireEvent.click(
      await screen.findByRole('tab', { name: 'Advance for a supply' }),
    );

    // Until the supply is named, the confirm is not available: what the
    // payment is FOR is the fact that makes it taxable.
    const confirmName = 'Record prepayment · +124.00 €';
    const disabled = screen.getAllByRole('button', { name: confirmName });
    expect(disabled[disabled.length - 1]).toBeDisabled();

    fireEvent.change(await screen.findByPlaceholderText(/Website build/), {
      target: { value: 'Website build, delivery March' },
    });
    // The 24 EUR inside the 124 is shown before anything is posted.
    expect(await screen.findByText(/24\.00 € of VAT/)).toBeInTheDocument();

    const confirms = screen.getAllByRole('button', { name: confirmName });
    fireEvent.click(confirms[confirms.length - 1]);
    await waitFor(() =>
      expect(api.createPrepayment).toHaveBeenCalledWith(9, {
        tax_treatment: 'taxable_supply',
        vat_code: 'EE_OUTPUT_24',
        supply_description: 'Website build, delivery March',
      }),
    );
  });

  it('leaves an outgoing supplier prepayment a one-tap confirm (#213)', async () => {
    mockLine({ amount: -50000, description: 'Ettemaks tarnijale' });
    vi.mocked(api.createPrepayment).mockResolvedValue({} as never);
    renderTx();
    fireEvent.click(
      await screen.findByText('Personal · Bank fee · Prepayment'),
    );
    fireEvent.click(await screen.findByText('Prepayment'));

    // No tax question at all: a supplier advance declares no output VAT.
    expect(screen.queryByText('What is this money?')).toBeNull();
    const confirms = screen.getAllByRole('button', {
      name: 'Record prepayment · −500.00 €',
    });
    fireEvent.click(confirms[confirms.length - 1]);
    await waitFor(() =>
      expect(api.createPrepayment).toHaveBeenCalledWith(9, undefined),
    );
    // And it is NOT reported as held: nothing about it is pending.
    expect(
      await screen.findByText('Recorded as prepayment'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/held until its tax treatment/)).toBeNull();
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
    await waitFor(() =>
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
