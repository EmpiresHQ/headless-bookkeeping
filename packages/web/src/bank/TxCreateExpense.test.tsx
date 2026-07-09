import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
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
  onboardEntity: vi.fn(),
  addEntityAlias: vi.fn(),
  fmtCents: (cents: number) => (cents / 100).toFixed(2),
}));

import * as api from '../api';
import { TxCreateExpense } from './TxCreateExpense';

const TX = {
  id: 9,
  transaction_date: '2026-06-27',
  description: 'WOLT 220627',
  amount: -1860,
  currency: 'EUR',
  counterparty_iban: null,
  counterparty_descriptor: null,
  reference: null,
  status: 'open',
} as const;

function renderForm(onDone = vi.fn()) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <TxCreateExpense statementId={3} tx={TX as never} onDone={onDone} />
    </QueryClientProvider>,
  );
  return onDone;
}

describe('TxCreateExpense', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
  });

  it('prefills VAT at 22% of gross and states the outcome on the button', async () => {
    renderForm();
    // 18.60 gross → 3.35 VAT.
    expect(await screen.findByLabelText('VAT (EUR)')).toHaveValue('3.35');
    expect(screen.getByText('27.06.2026 · from the line')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Create & match · -18.60 €' }),
    ).toBeDisabled(); // no category chosen yet
  });

  it('forces VAT to 0 when "No receipt" is chosen', async () => {
    renderForm();
    fireEvent.click(await screen.findByText('No receipt'));
    expect(screen.getByLabelText('VAT (EUR)')).toHaveValue('0.00');
    expect(screen.getByLabelText('VAT (EUR)')).toBeDisabled();
  });

  it('submits the composed flow with the chosen category and VAT', async () => {
    vi.mocked(api.createExpense).mockResolvedValue({ id: 55 } as never);
    vi.mocked(api.postExpense).mockResolvedValue({
      expense: { id: 55, status: 'posted' },
      policy: { action: 'auto-post', reason: 'ok' },
    } as never);
    vi.mocked(api.getMatchCandidates).mockResolvedValue({
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
    });
    vi.mocked(api.manualMatch).mockResolvedValue({
      records: [{ id: 88 }],
      approvals: [{ id: 12, matchId: 88 }],
    });
    vi.mocked(api.approveApproval).mockResolvedValue({
      approval: {},
    } as never);
    const onDone = renderForm();
    // Wait for the categories query to populate the <option>s — the label
    // is present on mount, but the options only exist once the query settles.
    await screen.findByText('Meals');
    fireEvent.change(screen.getByLabelText('Category'), {
      target: { value: 'meals' },
    });
    fireEvent.click(screen.getByText('No receipt'));
    fireEvent.click(
      screen.getByRole('button', { name: 'Create & match · -18.60 €' }),
    );
    await vi.waitFor(() =>
      expect(onDone).toHaveBeenCalledWith({
        outcome: 'matched',
        expenseId: 55,
        matchId: 88,
      }),
    );
    expect(api.createExpense).toHaveBeenCalledWith({
      category: 'meals',
      gross_amount: 1860,
      vat_amount: 0, // no receipt → no deductible input VAT
      currency: 'EUR',
      tax_point_date: '2026-06-27',
      supplier_id: null,
    });
  });

  it('passes the held outcome up when policy holds the expense', async () => {
    vi.mocked(api.createExpense).mockResolvedValue({ id: 56 } as never);
    vi.mocked(api.postExpense).mockResolvedValue({
      expense: { id: 56, status: 'pending' },
      policy: { action: 'hold-for-approval', reason: 'over ceiling' },
    } as never);
    const onDone = renderForm();
    await screen.findByText('Meals');
    fireEvent.change(screen.getByLabelText('Category'), {
      target: { value: 'meals' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Create & match · -18.60 €' }),
    );
    await vi.waitFor(() =>
      expect(onDone).toHaveBeenCalledWith({
        outcome: 'held',
        expenseId: 56,
        reason: 'over ceiling',
      }),
    );
  });
});
