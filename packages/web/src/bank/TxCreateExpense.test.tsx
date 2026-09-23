import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
}));

import * as api from '../api';
import { TxCreateExpense } from './TxCreateExpense';
import { MemoryRouter } from 'react-router-dom';
import { usePendingOperation } from '../lib/pendingOperation';
import { UnsavedChangesProvider } from '../lib/unsavedChanges';

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

/** TxScreen owns the line's operation; the form borrows it. */
function CreateWithOp(
  props: Omit<React.ComponentProps<typeof TxCreateExpense>, 'op'>,
) {
  const op = usePendingOperation('Bank line');
  return <TxCreateExpense {...props} op={op} />;
}

function renderForm(onDone = vi.fn()) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <UnsavedChangesProvider onUnauthorized={() => undefined}>
          <CreateWithOp statementId={3} tx={TX as never} onDone={onDone} />
        </UnsavedChangesProvider>
      </MemoryRouter>
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
  });

  it('prefills VAT at 22% of gross and states the outcome on the button', async () => {
    renderForm();
    // 18.60 gross → 3.35 VAT.
    expect(await screen.findByLabelText('VAT (EUR)')).toHaveValue('3.35');
    expect(screen.getByText('27.06.2026 · from the line')).toBeInTheDocument();
    // No category chosen yet (#265): once the lists are usable the button
    // is live, and a click names the missing category instead of nothing.
    await screen.findByText('Meals');
    const submit = screen.getByRole('button', {
      name: 'Create & match · −18.60 €',
    });
    await waitFor(() => expect(submit).toBeEnabled());
    fireEvent.click(submit);
    const category = screen.getByLabelText('Category');
    expect(category).toHaveAccessibleDescription('Choose a category');
    await waitFor(() => expect(category).toHaveFocus());
    expect(api.createExpense).not.toHaveBeenCalled();
  });

  it('VAT above the line amount is explained at the field (bank rule) and nothing is sent (#265)', async () => {
    renderForm();
    await screen.findByText('Meals');
    fireEvent.change(screen.getByLabelText('Category'), {
      target: { value: 'meals' },
    });
    const vat = screen.getByLabelText('VAT (EUR)');
    fireEvent.change(vat, { target: { value: '18.61' } });
    fireEvent.blur(vat);
    expect(vat).toHaveAttribute('aria-invalid', 'true');
    expect(vat).toHaveAccessibleDescription(
      'VAT cannot exceed the line amount (18.60)',
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Create & match · −18.60 €' }),
    );
    expect(api.createExpense).not.toHaveBeenCalled();
    await waitFor(() => expect(vat).toHaveFocus());
    fireEvent.change(vat, { target: { value: '18.60' } });
    expect(vat).not.toHaveAttribute('aria-invalid');
  });

  it("a refused create maps the server's field error; input kept, no stage landed (#265)", async () => {
    const { HttpError } = await import('../auth');
    vi.mocked(api.createExpense).mockRejectedValue(
      new HttpError(400, '400 Bad Request: vat_amount: cannot be negative', {
        fields: { vat_amount: ['cannot be negative'] },
        formErrors: [],
      }),
    );
    renderForm();
    await screen.findByText('Meals');
    fireEvent.change(screen.getByLabelText('Category'), {
      target: { value: 'meals' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Create & match · −18.60 €' }),
    );
    const vat = screen.getByLabelText('VAT (EUR)');
    await waitFor(() =>
      expect(vat).toHaveAccessibleDescription('cannot be negative'),
    );
    expect(vat).toHaveValue('3.35');
    expect(vat).not.toBeDisabled();
    await waitFor(() => expect(vat).toHaveFocus());
    expect(
      screen.getByText(/Not saved — the server refused these values/),
    ).toBeInTheDocument();
    expect(api.postExpense).not.toHaveBeenCalled();
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
      screen.getByRole('button', { name: 'Create & match · −18.60 €' }),
    );
    await waitFor(() =>
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

  it('resumes a landed expense after a failed post: locked facts, link + status, no second create (#251)', async () => {
    vi.mocked(api.createExpense).mockResolvedValue({ id: 24 } as never);
    vi.mocked(api.postExpense)
      .mockRejectedValueOnce(new Error('503 Service Unavailable'))
      .mockResolvedValue({
        expense: { id: 24, status: 'posted' },
        policy: { action: 'hold-for-approval', reason: 'over ceiling' },
      } as never);
    const onDone = renderForm();
    await screen.findByText('Meals');
    fireEvent.change(screen.getByLabelText('Category'), {
      target: { value: 'meals' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Create & match · −18.60 €' }),
    );
    const finish = await screen.findByRole('button', {
      name: 'Finish · expense #24',
    });
    expect(screen.getByRole('link', { name: 'Expense #24' })).toHaveAttribute(
      'href',
      '/books/expenses/24',
    );
    expect(
      screen.getByText(/created as a draft but not posted/),
    ).toBeInTheDocument();
    // Its facts are the server's now: editing them cannot pretend to apply.
    expect(screen.getByLabelText('Category')).toBeDisabled();
    expect(screen.getByLabelText('VAT (EUR)')).toBeDisabled();
    // #265: the form states the partial truth — saved, a later step failed —
    // never "not saved", and maps nothing onto the locked fields.
    expect(
      screen.getByText(
        /Expense #24 is already saved, but a later step did not complete/,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Not saved/)).toBeNull();
    expect(screen.getByLabelText('VAT (EUR)')).not.toHaveAttribute(
      'aria-invalid',
    );
    fireEvent.click(finish);
    await waitFor(() =>
      expect(onDone).toHaveBeenCalledWith({
        outcome: 'held',
        expenseId: 24,
        reason: 'over ceiling',
      }),
    );
    expect(api.createExpense).toHaveBeenCalledTimes(1);
    expect(api.postExpense).toHaveBeenCalledTimes(2);
    expect(api.postExpense).toHaveBeenLastCalledWith(24);
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
      screen.getByRole('button', { name: 'Create & match · −18.60 €' }),
    );
    await waitFor(() =>
      expect(onDone).toHaveBeenCalledWith({
        outcome: 'held',
        expenseId: 56,
        reason: 'over ceiling',
      }),
    );
  });
});
