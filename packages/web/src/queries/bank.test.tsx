import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
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
}));

import * as api from '../api';
import {
  bookManualMatch,
  bookProposals,
  confirmStagedMatch,
  createExpenseFromLine,
  undoMatches,
  useImportJob,
} from './bank';

const PROPOSAL = {
  bankTransactionId: 9,
  voucherId: 70,
  matchType: 'exact' as const,
  amountMatched: 1860,
  confidence: 'high' as const,
  signal: 'counterparty' as const,
  objectType: 'expense' as const,
  objectId: 55,
  objectLabel: 'Expense #55',
  counterpartyName: 'Wolt Eesti OÜ',
  voucherRemaining: 1860,
};

function makeWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
  };
}

describe('bookProposals', () => {
  beforeEach(() => vi.clearAllMocks());

  it('stages the matches then approves each returned approval', async () => {
    const order: string[] = [];
    vi.mocked(api.executeMatches).mockImplementation(async () => {
      order.push('stage');
      return {
        records: [{ id: 41 }, { id: 42 }],
        approvals: [
          { id: 9, matchId: 41 },
          { id: 10, matchId: 42 },
        ],
      };
    });
    vi.mocked(api.approveApproval).mockImplementation(async (id) => {
      order.push(`approve-${id}`);
      return { approval: { id } } as never;
    });
    const matchIds = await bookProposals(3, [PROPOSAL, PROPOSAL]);
    expect(matchIds).toEqual([41, 42]);
    expect(order).toEqual(['stage', 'approve-9', 'approve-10']);
    expect(api.approveApproval).toHaveBeenCalledWith(9, 'operator');
  });
});

describe('bookManualMatch / undoMatches / confirmStagedMatch', () => {
  beforeEach(() => vi.clearAllMocks());

  it('bookManualMatch stages one match and approves it', async () => {
    vi.mocked(api.manualMatch).mockResolvedValue({
      records: [{ id: 88 }],
      approvals: [{ id: 12, matchId: 88 }],
    });
    vi.mocked(api.approveApproval).mockResolvedValue({
      approval: { id: 12 },
    } as never);
    const matchId = await bookManualMatch(3, {
      bankTransactionId: 9,
      voucherId: 70,
      amountMatched: 1860,
      matchType: 'exact',
    });
    expect(matchId).toBe(88);
    expect(api.approveApproval).toHaveBeenCalledWith(12, 'operator');
  });

  it('undoMatches unmatches every id against the statement', async () => {
    vi.mocked(api.unmatchMatch).mockResolvedValue({});
    await undoMatches(3, [41, 42]);
    expect(api.unmatchMatch).toHaveBeenNthCalledWith(1, 3, 41);
    expect(api.unmatchMatch).toHaveBeenNthCalledWith(2, 3, 42);
  });

  it('confirmStagedMatch finds the pending reconciliation approval and approves it', async () => {
    vi.mocked(api.getPendingApprovals).mockResolvedValue([
      {
        id: 77,
        object_type: 'reconciliation_match',
        object_id: 41,
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
      approval: { id: 77 },
    } as never);
    await confirmStagedMatch(41);
    expect(api.approveApproval).toHaveBeenCalledWith(77, 'operator');
  });

  it('confirmStagedMatch throws when no approval is pending for the match', async () => {
    vi.mocked(api.getPendingApprovals).mockResolvedValue([]);
    await expect(confirmStagedMatch(41)).rejects.toThrow(
      /no pending approval/i,
    );
  });
});

describe('createExpenseFromLine', () => {
  beforeEach(() => vi.clearAllMocks());

  const INPUT = {
    statementId: 3,
    bankTransactionId: 9,
    category: 'meals',
    grossCents: 1860,
    vatCents: 335,
    currency: 'EUR',
    taxPointDate: '2026-06-27',
    supplierId: 12,
  };

  it('creates, posts, finds its own candidate, matches exact, approves', async () => {
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
          counterpartyName: 'Wolt Eesti OÜ',
          voucherRemaining: 1860,
        },
      ],
    });
    vi.mocked(api.manualMatch).mockResolvedValue({
      records: [{ id: 88 }],
      approvals: [{ id: 12, matchId: 88 }],
    });
    vi.mocked(api.approveApproval).mockResolvedValue({
      approval: { id: 12 },
    } as never);

    const res = await createExpenseFromLine(INPUT);
    expect(res).toEqual({ outcome: 'matched', expenseId: 55, matchId: 88 });
    expect(api.createExpense).toHaveBeenCalledWith({
      category: 'meals',
      gross_amount: 1860,
      vat_amount: 335,
      currency: 'EUR',
      tax_point_date: '2026-06-27',
      supplier_id: 12,
    });
    expect(api.manualMatch).toHaveBeenCalledWith(3, {
      bankTransactionId: 9,
      voucherId: 70,
      amountMatched: 1860,
      matchType: 'exact',
    });
  });

  it('returns held (and does NOT try to match) when policy holds the expense', async () => {
    vi.mocked(api.createExpense).mockResolvedValue({ id: 56 } as never);
    vi.mocked(api.postExpense).mockResolvedValue({
      expense: { id: 56, status: 'pending' },
      policy: {
        action: 'hold-for-approval',
        reason: 'amount 240.00 above ceiling 50.00',
      },
    } as never);
    const res = await createExpenseFromLine(INPUT);
    expect(res).toEqual({
      outcome: 'held',
      expenseId: 56,
      reason: 'amount 240.00 above ceiling 50.00',
    });
    expect(api.getMatchCandidates).not.toHaveBeenCalled();
    expect(api.manualMatch).not.toHaveBeenCalled();
  });
});

describe('useImportJob', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does not fetch while jobId is null', () => {
    renderHook(() => useImportJob(null), { wrapper: makeWrapper() });
    expect(api.getBankImportStatus).not.toHaveBeenCalled();
  });

  it('fetches the job when an id is set', async () => {
    vi.mocked(api.getBankImportStatus).mockResolvedValue({
      id: 7,
      status: 'done',
      account_code: 'BANK_EUR',
      statement_id: 5,
      error: null,
    });
    const { result } = renderHook(() => useImportJob(7), {
      wrapper: makeWrapper(),
    });
    await waitFor(() => expect(result.current.data?.status).toBe('done'));
    expect(api.getBankImportStatus).toHaveBeenCalledWith(7);
  });
});
