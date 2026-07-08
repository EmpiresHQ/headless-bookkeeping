import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setToken } from './auth';
import {
  executeMatches,
  manualMatch,
  postExpense,
  type MatchProposalView,
} from './api';

const PROPOSAL: MatchProposalView = {
  bankTransactionId: 9,
  voucherId: 70,
  matchType: 'exact',
  amountMatched: 1860,
  confidence: 'high',
  signal: 'counterparty',
  objectType: 'expense',
  objectId: 55,
  objectLabel: 'Expense #55',
  counterpartyName: 'Wolt Eesti OÜ',
  voucherRemaining: 1860,
};

describe('bank api additions', () => {
  beforeEach(() => {
    localStorage.clear();
    setToken('tok');
  });
  afterEach(() => vi.restoreAllMocks());

  it('postExpense POSTs the pipeline endpoint and returns expense + policy', async () => {
    const body = JSON.stringify({
      expense: { id: 7, status: 'posted' },
      voucher: { id: 1 },
      policy: { action: 'auto-post', reason: 'all gates passed' },
    });
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(body, { status: 201 }));
    const res = await postExpense(7);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/expenses/7/post');
    expect(init?.method).toBe('POST');
    expect(res.policy.action).toBe('auto-post');
    expect(res.expense.id).toBe(7);
  });

  it('executeMatches surfaces the approvals created alongside draft matches', async () => {
    const body = JSON.stringify({
      records: [{ id: 41 }],
      approvals: [{ id: 9, matchId: 41 }],
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(body, { status: 201 }),
    );
    const res = await executeMatches(3, [PROPOSAL]);
    expect(res.records).toEqual([{ id: 41 }]);
    expect(res.approvals).toEqual([{ id: 9, matchId: 41 }]);
  });

  it('manualMatch surfaces approvals too and sends signal manual', async () => {
    const body = JSON.stringify({
      records: [{ id: 42 }],
      approvals: [{ id: 10, matchId: 42 }],
    });
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(body, { status: 201 }));
    const res = await manualMatch(3, {
      bankTransactionId: 9,
      voucherId: 70,
      amountMatched: 1860,
      matchType: 'exact',
    });
    expect(res.approvals[0].matchId).toBe(42);
    const [, init] = fetchMock.mock.calls[0];
    const sent = JSON.parse(String(init?.body)) as {
      matches: { signal: string }[];
    };
    expect(sent.matches[0].signal).toBe('manual');
  });
});
