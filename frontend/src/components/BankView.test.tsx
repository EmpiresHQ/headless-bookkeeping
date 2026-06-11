import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { BankView } from './BankView';
import * as api from '../api';

vi.mock('../api', () => ({
  importBankStatement: vi.fn(),
  getBankImportStatus: vi.fn(),
  listBankStatements: vi.fn(),
  listBankTransactions: vi.fn(),
  deleteBankStatement: vi.fn(),
  proposeMatches: vi.fn(),
  getReconciliationStatus: vi.fn(),
  executeMatches: vi.fn(),
  getMatchCandidates: vi.fn(),
  manualMatch: vi.fn(),
  getStatementMatches: vi.fn(),
  unmatchMatch: vi.fn(),
  createPrepayment: vi.fn(),
  markPersonal: vi.fn(),
  fmtCents: (cents: number) => (cents / 100).toFixed(2),
}));

describe('BankView', () => {
  beforeEach(() => {
    vi.mocked(api.importBankStatement).mockResolvedValue({ jobId: 7 });
    // First (immediate) poll already returns `done`, so the component stops
    // polling right away — no fake timers or real 1.5s waits needed.
    vi.mocked(api.getBankImportStatus).mockResolvedValue({
      id: 7,
      status: 'done',
      account_code: 'BANK_EUR',
      statement_id: 5,
      error: null,
    });
    vi.mocked(api.listBankStatements).mockResolvedValue([]);
    vi.mocked(api.listBankTransactions).mockResolvedValue([]);
    vi.mocked(api.getReconciliationStatus).mockResolvedValue([]);
    vi.mocked(api.getStatementMatches).mockResolvedValue([]);
    vi.mocked(api.proposeMatches).mockResolvedValue([]);
    vi.mocked(api.executeMatches).mockResolvedValue({ records: [] });
    vi.mocked(api.createPrepayment).mockResolvedValue(undefined);
    vi.mocked(api.markPersonal).mockResolvedValue(undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it('imports a CSV and shows the created statement', async () => {
    render(<BankView />);

    const fileInput = screen.getByLabelText(
      'Bank statement CSV',
    ) as HTMLInputElement;
    const file = new File(['Date,Amount\n'], 's.csv', { type: 'text/csv' });
    fireEvent.change(fileInput, { target: { files: [file] } });

    const accountInput = screen.getByLabelText('Account code') as HTMLInputElement;
    fireEvent.change(accountInput, { target: { value: 'BANK_EUR' } });

    fireEvent.click(screen.getByRole('button', { name: /import/i }));

    expect(
      await screen.findByText('Created statement #5'),
    ).toBeInTheDocument();
    expect(api.importBankStatement).toHaveBeenCalledWith(file, 'BANK_EUR');
  });

  it('lists statements and shows transactions on View', async () => {
    vi.mocked(api.listBankStatements).mockResolvedValue([
      { id: 5, start_date: '2026-05-01', end_date: '2026-05-31', uploaded_at: 0 },
    ]);
    vi.mocked(api.listBankTransactions).mockResolvedValue([
      {
        id: 1,
        transaction_date: '2026-05-08',
        description: 'Invoice 1000',
        amount: 615700,
        currency: 'EUR',
        counterparty_iban: 'DK7430000014041346',
        counterparty_descriptor: null,
        reference: 'REF1',
        status: 'unreconciled',
      },
    ]);

    render(<BankView />);

    // The statement row renders its period from the loaded list.
    expect(
      await screen.findByText('2026-05-01 → 2026-05-31'),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /view/i }));

    // The transaction's amount + counterparty render after the drill-down load.
    expect(await screen.findByText('6157.00')).toBeInTheDocument();
    expect(screen.getByText('DK7430000014041346')).toBeInTheDocument();
    expect(api.listBankTransactions).toHaveBeenCalledWith(5);
  });

  it('deletes a statement after confirmation and reloads the list', async () => {
    vi.mocked(api.listBankStatements)
      .mockResolvedValueOnce([
        { id: 5, start_date: '2026-05-01', end_date: '2026-05-31', uploaded_at: 0 },
      ])
      .mockResolvedValue([]); // after delete: empty
    vi.mocked(api.deleteBankStatement).mockResolvedValue({ deleted: 5 });
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(<BankView />);
    await screen.findByText('2026-05-01 → 2026-05-31');

    fireEvent.click(screen.getByRole('button', { name: /delete/i }));

    expect(await screen.findByText('No statements yet.')).toBeInTheDocument();
    expect(api.deleteBankStatement).toHaveBeenCalledWith(5);
    confirmSpy.mockRestore();
  });

  it('shows a match badge from reconciliation status', async () => {
    vi.mocked(api.listBankStatements).mockResolvedValue([
      { id: 5, start_date: '2026-05-01', end_date: '2026-05-31', uploaded_at: 0 },
    ]);
    vi.mocked(api.listBankTransactions).mockResolvedValue([
      {
        id: 1,
        transaction_date: '2026-05-08',
        description: 'Invoice 1000',
        amount: 615700,
        currency: 'EUR',
        counterparty_iban: 'DK7430000014041346',
        counterparty_descriptor: null,
        reference: 'REF1',
        status: 'unreconciled',
      },
    ]);
    vi.mocked(api.getReconciliationStatus).mockResolvedValue([
      {
        bankTransactionId: 1,
        amountBase: 615700,
        matchedSum: 100000,
        remaining: 515700,
        reconStatus: 'partial',
      },
    ]);

    render(<BankView />);
    await screen.findByText('2026-05-01 → 2026-05-31');
    fireEvent.click(screen.getByRole('button', { name: /view/i }));

    // Partial badge renders the remaining amount.
    expect(await screen.findByText('5157.00 left')).toBeInTheDocument();
    expect(api.getReconciliationStatus).toHaveBeenCalledWith(5);
  });

  it('proposes matches and books a selected proposal', async () => {
    vi.mocked(api.listBankStatements).mockResolvedValue([
      { id: 5, start_date: '2026-05-01', end_date: '2026-05-31', uploaded_at: 0 },
    ]);
    vi.mocked(api.listBankTransactions).mockResolvedValue([
      {
        id: 1,
        transaction_date: '2026-05-08',
        description: 'Invoice 1000',
        amount: 615700,
        currency: 'EUR',
        counterparty_iban: 'DK7430000014041346',
        counterparty_descriptor: null,
        reference: 'REF1',
        status: 'unreconciled',
      },
    ]);
    vi.mocked(api.getReconciliationStatus).mockResolvedValue([
      {
        bankTransactionId: 1,
        amountBase: 615700,
        matchedSum: 0,
        remaining: 615700,
        reconStatus: 'open',
      },
    ]);
    vi.mocked(api.proposeMatches).mockResolvedValue([
      {
        bankTransactionId: 1,
        voucherId: 9999,
        matchType: 'exact',
        amountMatched: 615700,
        confidence: 'high',
        signal: 'invoice_number',
        objectType: 'sales_invoice',
        objectId: 42,
        objectLabel: 'INV-1',
        counterpartyName: 'Acme',
        voucherRemaining: 615700,
      },
    ]);

    render(<BankView />);
    await screen.findByText('2026-05-01 → 2026-05-31');
    fireEvent.click(screen.getByRole('button', { name: /view/i }));
    await screen.findByText('6157.00');

    fireEvent.click(screen.getByRole('button', { name: /propose matches/i }));

    // Business label + counterparty render; the voucherId is NEVER shown.
    expect(await screen.findByText('INV-1')).toBeInTheDocument();
    expect(screen.getByText('Acme')).toBeInTheDocument();
    expect(screen.queryByText('9999')).not.toBeInTheDocument();

    // Select the proposal then book it.
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: /book selected/i }));

    await vi.waitFor(() => {
      expect(api.executeMatches).toHaveBeenCalled();
    });
    const [statementArg, proposalsArg] = vi.mocked(api.executeMatches).mock
      .calls[0];
    expect(statementArg).toBe(5);
    expect(proposalsArg).toHaveLength(1);
    expect(proposalsArg[0].objectLabel).toBe('INV-1');
    // Status refetched after booking (initial load + post-book).
    expect(
      vi.mocked(api.getReconciliationStatus).mock.calls.length,
    ).toBeGreaterThanOrEqual(2);
  });

  it('dispositions an open outgoing txn as personal', async () => {
    vi.mocked(api.listBankStatements).mockResolvedValue([
      { id: 5, start_date: '2026-05-01', end_date: '2026-05-31', uploaded_at: 0 },
    ]);
    vi.mocked(api.listBankTransactions).mockResolvedValue([
      {
        id: 1,
        transaction_date: '2026-05-08',
        description: 'Coffee shop',
        amount: -1200,
        currency: 'EUR',
        counterparty_iban: null,
        counterparty_descriptor: 'CAFE',
        reference: null,
        status: 'unreconciled',
      },
    ]);
    vi.mocked(api.getReconciliationStatus).mockResolvedValue([
      {
        bankTransactionId: 1,
        amountBase: 1200,
        matchedSum: 0,
        remaining: 1200,
        reconStatus: 'open',
      },
    ]);
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(<BankView />);
    await screen.findByText('2026-05-01 → 2026-05-31');
    fireEvent.click(screen.getByRole('button', { name: /view/i }));
    await screen.findByText('-12.00');

    fireEvent.click(screen.getByRole('button', { name: /personal/i }));

    await vi.waitFor(() => {
      expect(api.markPersonal).toHaveBeenCalledWith(1);
    });
    confirmSpy.mockRestore();
  });
});
