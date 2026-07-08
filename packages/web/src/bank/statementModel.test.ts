import { describe, expect, it } from 'vitest';
import type {
  BankTransaction,
  MatchProposalView,
  MatchRowView,
  ReconciliationStatusRow,
} from '../api';
import { bucketOf, buildLines } from './statementModel';

const tx = (over: Partial<BankTransaction>): BankTransaction => ({
  id: 1,
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
const recon = (
  over: Partial<ReconciliationStatusRow>,
): ReconciliationStatusRow => ({
  bankTransactionId: 1,
  amountBase: 1860,
  matchedSum: 0,
  remaining: 1860,
  reconStatus: 'open',
  ...over,
});
const match = (over: Partial<MatchRowView>): MatchRowView => ({
  id: 41,
  bankTransactionId: 1,
  status: 'active',
  amountMatched: 1860,
  objectLabel: 'Expense #55',
  counterpartyName: null,
  ...over,
});
const proposal = (over: Partial<MatchProposalView>): MatchProposalView => ({
  bankTransactionId: 1,
  voucherId: 70,
  matchType: 'exact',
  amountMatched: 1860,
  confidence: 'high',
  signal: 'counterparty',
  objectType: 'expense',
  objectId: 55,
  objectLabel: 'Expense #55',
  counterpartyName: null,
  voucherRemaining: 1860,
  ...over,
});

describe('buildLines / bucketOf', () => {
  it('joins per-line data and preserves statement order', () => {
    const lines = buildLines(
      [tx({ id: 1 }), tx({ id: 2 })],
      [recon({ bankTransactionId: 2, reconStatus: 'matched' })],
      [match({ bankTransactionId: 2 })],
      [proposal({ bankTransactionId: 1 })],
    );
    expect(lines.map((l) => l.tx.id)).toEqual([1, 2]);
    expect(lines[0].proposals).toHaveLength(1);
    expect(lines[1].active).toHaveLength(1);
  });

  it('routes buckets: disposition and fully-matched are done', () => {
    expect(bucketOf(buildLines([tx({ status: 'personal' })], [], [], [])[0])).toBe('done');
    expect(
      bucketOf(
        buildLines([tx({})], [recon({ reconStatus: 'matched' })], [], [])[0],
      ),
    ).toBe('done');
  });

  it('routes buckets: proposals or staged drafts go to the proposals tier', () => {
    expect(bucketOf(buildLines([tx({})], [], [], [proposal({})])[0])).toBe(
      'proposals',
    );
    expect(
      bucketOf(buildLines([tx({})], [], [match({ status: 'draft' })], [])[0]),
    ).toBe('proposals');
  });

  it('routes buckets: open and partial lines are decide-yourself', () => {
    expect(bucketOf(buildLines([tx({})], [recon({})], [], [])[0])).toBe('decide');
    expect(
      bucketOf(
        buildLines(
          [tx({})],
          [recon({ reconStatus: 'partial', matchedSum: 860, remaining: 1000 })],
          [match({ amountMatched: 860 })],
          [],
        )[0],
      ),
    ).toBe('decide');
  });
});
