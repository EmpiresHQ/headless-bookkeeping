import { describe, expect, it } from 'vitest';
import type { BankTransaction, MatchProposalView, MatchRowView } from '../api';
import { searchNeedle } from '../lib/searchText';
import { lineMatches } from './search';
import type { LineView } from './statementModel';

const tx = (over: Partial<BankTransaction>): BankTransaction => ({
  id: 1,
  transaction_date: '2026-06-27',
  description: null,
  amount: -1860,
  currency: 'EUR',
  counterparty_iban: null,
  counterparty_descriptor: null,
  reference: null,
  status: 'open',
  ...over,
});

const line = (over: Partial<LineView> & { tx: BankTransaction }): LineView => ({
  recon: undefined,
  active: [],
  staged: [],
  proposals: [],
  ...over,
});

const matches = (l: LineView, q: string) => {
  const needle = searchNeedle(q);
  if (needle === null) throw new Error('no needle');
  return lineMatches(l, needle);
};

describe('lineMatches (issue #278)', () => {
  const plain = line({
    tx: tx({
      description: 'WOLT 220627',
      counterparty_descriptor: 'Wolt Enterprises',
      reference: 'RF18 5390 0754',
      counterparty_iban: 'EE38 2200 2210 2014 5685',
    }),
  });

  it('description, counterparty, reference (punctuation/space kept)', () => {
    expect(matches(plain, 'wolt 2206')).toBe(true);
    expect(matches(plain, 'enterprises')).toBe(true);
    expect(matches(plain, 'rf18 5390')).toBe(true);
    expect(matches(plain, 'bolt')).toBe(false);
  });

  it('IBAN with or without its print grouping', () => {
    expect(matches(plain, 'EE382200')).toBe(true);
    expect(matches(plain, 'ee38 2200 2210')).toBe(true);
  });

  it('amount magnitude and date', () => {
    expect(matches(plain, '18,60')).toBe(true);
    expect(matches(plain, '−18.60')).toBe(true);
    expect(matches(plain, '27 jun')).toBe(true);
    expect(matches(plain, '2026-06-27')).toBe(true);
    expect(matches(plain, '28 jun')).toBe(false);
  });

  it('what the row shows after "→": proposal, staged and active targets', () => {
    const p = {
      objectLabel: 'Invoice 2026-018',
      counterpartyName: 'Nordic Consulting OÜ',
    } as MatchProposalView;
    const m = {
      objectLabel: 'Expense #61',
      counterpartyName: 'Elisa Eesti AS',
    } as MatchRowView;
    const bare = tx({ description: 'X', amount: 1 });
    expect(matches(line({ tx: bare, proposals: [p] }), '2026-018')).toBe(true);
    expect(matches(line({ tx: bare, proposals: [p] }), 'nordic')).toBe(true);
    expect(matches(line({ tx: bare, staged: [m] }), 'expense #61')).toBe(true);
    expect(matches(line({ tx: bare, active: [m] }), 'elisa')).toBe(true);
    expect(matches(line({ tx: bare }), 'elisa')).toBe(false);
  });
});
