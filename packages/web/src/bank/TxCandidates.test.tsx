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
  fmtCents: (cents: number) => (cents / 100).toFixed(2),
}));

import * as api from '../api';
import { TxCandidates } from './TxCandidates';

const TX = {
  id: 9,
  transaction_date: '2026-06-26',
  description: 'ETTEMAKS Baltic Trade',
  amount: 50000,
  currency: 'EUR',
  counterparty_iban: null,
  counterparty_descriptor: null,
  reference: null,
  status: 'open',
} as const;

const RESULT = {
  bankTransactionId: 9,
  lineRemaining: 50000,
  candidates: [
    {
      voucherId: 70,
      objectType: 'sales_invoice' as const,
      objectId: 14,
      objectLabel: 'Invoice 2026-014',
      counterpartyName: 'Baltic Trade OÜ',
      voucherRemaining: 30000,
    },
    {
      voucherId: 71,
      objectType: 'sales_invoice' as const,
      objectId: 11,
      objectLabel: 'Invoice 2026-011',
      counterpartyName: 'Baltic Trade OÜ',
      voucherRemaining: 20000,
    },
  ],
};

describe('TxCandidates', () => {
  beforeEach(() => vi.clearAllMocks());

  it('preselects proposal candidates and shows the live remainder', () => {
    render(
      <TxCandidates
        statementId={3}
        tx={TX as never}
        result={RESULT}
        preselectVoucherIds={[70]}
        onMatched={vi.fn()}
      />,
    );
    expect(
      screen.getByRole('checkbox', { name: /invoice 2026-014/i }),
    ).toHaveAttribute('aria-checked', 'true');
    // 500 line − 300 selected → 200 remainder, stays open.
    expect(screen.getByText(/Line remainder · 200.00 €/)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Match 300.00 €' }),
    ).toBeInTheDocument();
  });

  it('recomputes the button on every toggle and disables at zero selection', () => {
    render(
      <TxCandidates
        statementId={3}
        tx={TX as never}
        result={RESULT}
        preselectVoucherIds={[]}
        onMatched={vi.fn()}
      />,
    );
    const btn = screen.getByRole('button', { name: /^Match/ });
    expect(btn).toBeDisabled();
    fireEvent.click(
      screen.getByRole('checkbox', { name: /invoice 2026-014/i }),
    );
    fireEvent.click(
      screen.getByRole('checkbox', { name: /invoice 2026-011/i }),
    );
    expect(
      screen.getByRole('button', { name: 'Match 500.00 €' }),
    ).toBeInTheDocument();
    // Full coverage → no remainder bar.
    expect(screen.queryByText(/Line remainder/)).toBeNull();
  });

  it('books one manual match per selected candidate with allocated amounts', async () => {
    vi.mocked(api.manualMatch)
      .mockResolvedValueOnce({
        records: [{ id: 91 }],
        approvals: [{ id: 12, matchId: 91 }],
      })
      .mockResolvedValueOnce({
        records: [{ id: 92 }],
        approvals: [{ id: 13, matchId: 92 }],
      });
    vi.mocked(api.approveApproval).mockResolvedValue({
      approval: {},
    } as never);
    const onMatched = vi.fn();
    render(
      <TxCandidates
        statementId={3}
        tx={TX as never}
        result={RESULT}
        preselectVoucherIds={[70, 71]}
        onMatched={onMatched}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Match 500.00 €' }));
    await vi.waitFor(() =>
      expect(onMatched).toHaveBeenCalledWith([91, 92], 50000),
    );
    expect(api.manualMatch).toHaveBeenNthCalledWith(1, 3, {
      bankTransactionId: 9,
      voucherId: 70,
      amountMatched: 30000,
      matchType: 'partial',
    });
    expect(api.manualMatch).toHaveBeenNthCalledWith(2, 3, {
      bankTransactionId: 9,
      voucherId: 71,
      amountMatched: 20000,
      matchType: 'partial',
    });
  });
});
