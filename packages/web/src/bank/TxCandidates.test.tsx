import type { ReactElement } from 'react';
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
}));

import * as api from '../api';
import { AppToaster } from '../ui/toast';
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

/** TxCandidates now reads useQueryClient() (fix #3, zero-landed
 *  invalidation) — every render needs a QueryClientProvider. Returns the
 *  client so tests can spy on invalidateQueries. */
function renderWithClient(
  ui: ReactElement,
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
  render(
    <QueryClientProvider client={client}>
      {ui}
      <AppToaster />
    </QueryClientProvider>,
  );
  return client;
}

describe('TxCandidates', () => {
  beforeEach(() => vi.clearAllMocks());

  it('preselects proposal candidates and shows the live remainder', () => {
    renderWithClient(
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
    renderWithClient(
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
    renderWithClient(
      <TxCandidates
        statementId={3}
        tx={TX as never}
        result={RESULT}
        preselectVoucherIds={[70, 71]}
        onMatched={onMatched}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Match 500.00 €' }));
    await waitFor(() =>
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

  it('clamps allocation to the line remaining when the voucher outstanding is larger', async () => {
    const CLAMP_RESULT = {
      bankTransactionId: 9,
      lineRemaining: 50000,
      candidates: [
        {
          voucherId: 80,
          objectType: 'sales_invoice' as const,
          objectId: 20,
          objectLabel: 'Invoice 2026-020',
          counterpartyName: 'Big Client OÜ',
          voucherRemaining: 60000,
        },
      ],
    };
    vi.mocked(api.manualMatch).mockResolvedValue({
      records: [{ id: 91 }],
      approvals: [{ id: 12, matchId: 91 }],
    });
    vi.mocked(api.approveApproval).mockResolvedValue({
      approval: {},
    } as never);
    const onMatched = vi.fn();
    renderWithClient(
      <TxCandidates
        statementId={3}
        tx={TX as never}
        result={CLAMP_RESULT}
        preselectVoucherIds={[80]}
        onMatched={onMatched}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Match 500.00 €' }));
    await waitFor(() => expect(onMatched).toHaveBeenCalledWith([91], 50000));
    expect(api.manualMatch).toHaveBeenCalledWith(3, {
      bankTransactionId: 9,
      voucherId: 80,
      amountMatched: 50000,
      matchType: 'partial',
    });
  });

  it('skips a selected candidate once the line is fully allocated — exactly one manualMatch call, second row still checked', async () => {
    const SKIP_RESULT = {
      bankTransactionId: 9,
      lineRemaining: 30000,
      candidates: [
        {
          voucherId: 90,
          objectType: 'sales_invoice' as const,
          objectId: 30,
          objectLabel: 'Invoice 2026-030',
          counterpartyName: 'Baltic Trade OÜ',
          voucherRemaining: 30000,
        },
        {
          voucherId: 91,
          objectType: 'sales_invoice' as const,
          objectId: 31,
          objectLabel: 'Invoice 2026-031',
          counterpartyName: 'Baltic Trade OÜ',
          voucherRemaining: 20000,
        },
      ],
    };
    vi.mocked(api.manualMatch).mockResolvedValue({
      records: [{ id: 91 }],
      approvals: [{ id: 12, matchId: 91 }],
    });
    vi.mocked(api.approveApproval).mockResolvedValue({
      approval: {},
    } as never);
    const onMatched = vi.fn();
    renderWithClient(
      <TxCandidates
        statementId={3}
        tx={TX as never}
        result={SKIP_RESULT}
        preselectVoucherIds={[90, 91]}
        onMatched={onMatched}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Match 300.00 €' }));
    await waitFor(() => expect(onMatched).toHaveBeenCalledWith([91], 30000));
    expect(api.manualMatch).toHaveBeenCalledTimes(1);
    expect(api.manualMatch).toHaveBeenCalledWith(3, {
      bankTransactionId: 9,
      voucherId: 90,
      amountMatched: 30000,
      matchType: 'exact',
    });
    // Pinning current zero-alloc behavior: the second candidate stays
    // selected in the UI even though it received no allocation.
    expect(
      screen.getByRole('checkbox', { name: /invoice 2026-031/i }),
    ).toHaveAttribute('aria-checked', 'true');
  });

  it('books an exact match when the single candidate exactly covers the line', async () => {
    const EXACT_RESULT = {
      bankTransactionId: 9,
      lineRemaining: 25000,
      candidates: [
        {
          voucherId: 95,
          objectType: 'sales_invoice' as const,
          objectId: 40,
          objectLabel: 'Invoice 2026-040',
          counterpartyName: 'Baltic Trade OÜ',
          voucherRemaining: 25000,
        },
      ],
    };
    vi.mocked(api.manualMatch).mockResolvedValue({
      records: [{ id: 99 }],
      approvals: [{ id: 20, matchId: 99 }],
    });
    vi.mocked(api.approveApproval).mockResolvedValue({
      approval: {},
    } as never);
    const onMatched = vi.fn();
    renderWithClient(
      <TxCandidates
        statementId={3}
        tx={TX as never}
        result={EXACT_RESULT}
        preselectVoucherIds={[95]}
        onMatched={onMatched}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Match 250.00 €' }));
    await waitFor(() => expect(onMatched).toHaveBeenCalledWith([99], 25000));
    expect(api.manualMatch).toHaveBeenCalledWith(3, {
      bankTransactionId: 9,
      voucherId: 95,
      amountMatched: 25000,
      matchType: 'exact',
    });
  });

  it('invalidates the statement when the first match fails after staging (zero landed)', async () => {
    // Staging succeeds (one record + one pending approval), but activation
    // fails — bookManualMatch's approveStaged throws BookingPartialError.
    // Nothing landed (matchIds stays empty), so the fix #3 catch branch
    // must refetch the statement so the line routes to matched-with-staged
    // and a Confirm primary, instead of leaving a stale, re-clickable list.
    vi.mocked(api.manualMatch).mockResolvedValueOnce({
      records: [{ id: 91 }],
      approvals: [{ id: 12, matchId: 91 }],
    });
    vi.mocked(api.approveApproval).mockRejectedValueOnce(
      new Error('Match of 30000 would over-allocate voucher 70'),
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries');
    const onMatched = vi.fn();
    renderWithClient(
      <TxCandidates
        statementId={3}
        tx={TX as never}
        result={RESULT}
        preselectVoucherIds={[70]}
        onMatched={onMatched}
      />,
      client,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Match 300.00 €' }));
    // Toast shown with the BookingPartialError's message.
    expect(
      await screen.findByText(/approval 12 failed \(0\/1 activated\)/),
    ).toBeInTheDocument();
    // Nothing landed — onMatched must NOT fire.
    expect(onMatched).not.toHaveBeenCalled();
    // The statement queries refetch (invalidateStatement → qc.invalidateQueries
    // with the statement's key prefix).
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ queryKey: ['bank', 'statements', 3] }),
      ),
    );
  });
});
