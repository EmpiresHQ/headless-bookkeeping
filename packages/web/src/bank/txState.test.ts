import { describe, expect, it } from 'vitest';
import type { BankTransaction, MatchRowView } from '../api';
import { routeTxState } from './txState';

const tx = (over: Partial<BankTransaction>): BankTransaction => ({
  id: 9,
  transaction_date: '2026-06-27',
  description: 'WOLT 220627',
  amount: -1860,
  currency: 'EUR',
  counterparty_iban: null,
  counterparty_descriptor: null,
  reference: null,
  status: 'open',
  ...over,
});
const match = (over: Partial<MatchRowView>): MatchRowView => ({
  id: 41,
  bankTransactionId: 9,
  status: 'active',
  amountMatched: 1860,
  objectLabel: 'Expense #55',
  counterpartyName: null,
  ...over,
});
const CANDS = {
  bankTransactionId: 9,
  lineRemaining: 1860,
  candidates: [
    {
      voucherId: 70,
      objectType: 'expense' as const,
      objectId: 55,
      objectLabel: 'Expense #55',
      counterpartyName: null,
      voucherRemaining: 1860,
    },
  ],
};

describe('routeTxState (first match wins)', () => {
  it('loading until tx and matches are known', () => {
    expect(
      routeTxState({ tx: undefined, matches: undefined, candidates: undefined })
        .kind,
    ).toBe('loading');
    expect(
      routeTxState({ tx: tx({}), matches: undefined, candidates: undefined })
        .kind,
    ).toBe('loading');
  });

  it('disposed for non-open statuses', () => {
    expect(
      routeTxState({
        tx: tx({ status: 'personal' }),
        matches: [],
        candidates: undefined,
      }),
    ).toEqual({ kind: 'disposed', status: 'personal' });
  });

  it('matched when any match rows exist, split active/staged', () => {
    const s = routeTxState({
      tx: tx({}),
      matches: [match({}), match({ id: 42, status: 'draft' })],
      candidates: undefined,
    });
    expect(s.kind).toBe('matched');
    if (s.kind === 'matched') {
      expect(s.active).toHaveLength(1);
      expect(s.staged).toHaveLength(1);
    }
  });

  it('waits for candidates before deciding the open-line states', () => {
    expect(
      routeTxState({ tx: tx({}), matches: [], candidates: undefined }).kind,
    ).toBe('loading');
  });

  it('candidates when the server found any', () => {
    const s = routeTxState({ tx: tx({}), matches: [], candidates: CANDS });
    expect(s.kind).toBe('candidates');
  });

  it('incoming-open for an incoming line without candidates', () => {
    expect(
      routeTxState({
        tx: tx({ amount: 50000 }),
        matches: [],
        candidates: { ...CANDS, candidates: [] },
      }).kind,
    ).toBe('incoming-open');
  });

  it('create for an outgoing line without candidates', () => {
    expect(
      routeTxState({
        tx: tx({}),
        matches: [],
        candidates: { ...CANDS, candidates: [] },
      }).kind,
    ).toBe('create');
  });

  it('ignores other lines’ matches', () => {
    expect(
      routeTxState({
        tx: tx({}),
        matches: [match({ bankTransactionId: 999 })],
        candidates: { ...CANDS, candidates: [] },
      }).kind,
    ).toBe('create');
  });
});
