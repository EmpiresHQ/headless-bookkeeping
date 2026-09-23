import { describe, expect, it } from 'vitest';
import type { Approval, MatchFacts } from '../api';
import { checkMatchFacts } from './matchFacts';

const APPROVAL = {
  object_type: 'reconciliation_match',
  object_id: 41,
} as Approval;

const LINE: MatchFacts['bankTransaction'] = {
  id: 501,
  statementId: 12,
  transactionDate: '2026-07-10',
  description: 'Payment',
  amount: 100000,
  currency: 'EUR',
  sourceAmount: null,
  sourceCurrency: null,
  counterpartyIban: null,
  counterpartyDescriptor: null,
  reference: null,
  status: 'open',
};

const base = (target: MatchFacts['target']): MatchFacts => ({
  matchId: 41,
  status: 'draft',
  matchType: 'exact',
  signal: null,
  amountMatched: 100000,
  baseCurrency: 'EUR',
  bankTransaction: LINE,
  line: {
    activeAllocatedBase: 0,
    activeCashBase: 0,
    otherDraftCount: 0,
    otherDraftAllocatedBase: 0,
  },
  target,
});

const INVOICE = base({
  kind: 'sales_invoice',
  advanceKind: null,
  objectId: 77,
  objectLabel: 'INV-1',
  counterpartyName: null,
  grossAmount: 100000,
  currency: 'EUR',
  voucherRemaining: 100000,
  advance: null,
});

const PREPAYMENT = base({
  kind: 'prepayment',
  advanceKind: 'customer',
  objectId: null,
  objectLabel: 'Customer advance',
  counterpartyName: 'Acme OÜ',
  grossAmount: null,
  currency: null,
  voucherRemaining: 100000,
  advance: {
    date: '2026-06-01',
    originalBaseAmount: 100000,
    currency: 'EUR',
    fundingLine: {
      transactionDate: '2026-06-01',
      description: null,
      reference: 'RF-1',
      amount: 100000,
      currency: 'EUR',
    },
    needsReview: false,
    taxTreatment: 'non_taxable_deposit',
    ownerResolved: true,
  },
});

const UNIDENTIFIED = base({
  kind: 'unidentified',
  advanceKind: null,
  objectId: null,
  objectLabel: 'Unidentified object',
  counterpartyName: null,
  grossAmount: null,
  currency: null,
  voucherRemaining: 0,
  advance: null,
});

/** Deep-set one dotted path on a copy (the payload is untrusted JSON). */
function withField(f: MatchFacts, path: string, value: unknown): unknown {
  const copy = JSON.parse(JSON.stringify(f)) as Record<string, unknown>;
  const keys = path.split('.');
  let at = copy;
  for (const k of keys.slice(0, -1)) at = at[k] as Record<string, unknown>;
  const last = keys[keys.length - 1];
  if (value === undefined) delete at[last];
  else at[last] = value;
  return copy;
}

describe('checkMatchFacts (issue #256)', () => {
  it('accepts a complete invoice and a complete, identified advance', () => {
    expect(checkMatchFacts(INVOICE, APPROVAL).ok).toBe(true);
    expect(checkMatchFacts(PREPAYMENT, APPROVAL).ok).toBe(true);
  });

  it('shows but never enables an unidentified target', () => {
    const r = checkMatchFacts(UNIDENTIFIED, APPROVAL);
    expect(r.ok).toBe(false);
    expect(r.facts).not.toBeNull();
  });

  it.each<[string, MatchFacts, string, unknown]>([
    ['non-object', INVOICE, 'target', 'x'],
    ['other match', INVOICE, 'matchId', 42],
    ['string id', INVOICE, 'matchId', '41'],
    ['unknown status', INVOICE, 'status', 'deleted'],
    ['zero amount', INVOICE, 'amountMatched', 0],
    ['fractional amount', INVOICE, 'amountMatched', 10.5],
    ['bad base currency', INVOICE, 'baseCurrency', 'euro'],
    ['zero line id', INVOICE, 'bankTransaction.id', 0],
    ['unsafe statement id', INVOICE, 'bankTransaction.statementId', 2 ** 60],
    ['bad line date', INVOICE, 'bankTransaction.transactionDate', '10.07.2026'],
    ['missing line currency', INVOICE, 'bankTransaction.currency', undefined],
    ['half an original amount', INVOICE, 'bankTransaction.sourceAmount', 5],
    ['object description', INVOICE, 'bankTransaction.description', {}],
    ['negative count', INVOICE, 'line.otherDraftCount', -1],
    ['missing remaining', INVOICE, 'target.voucherRemaining', undefined],
    ['invoice without id', INVOICE, 'target.objectId', null],
    ['invoice without total', INVOICE, 'target.grossAmount', null],
    ['invoice without currency', INVOICE, 'target.currency', undefined],
    ['invoice with advance kind', INVOICE, 'target.advanceKind', 'customer'],
    ['unknown kind', INVOICE, 'target.kind', 'voucher'],
    ['advance with object id', PREPAYMENT, 'target.objectId', 5],
    ['advance with gross amount object', PREPAYMENT, 'target.grossAmount', {}],
    ['advance with missing gross', PREPAYMENT, 'target.grossAmount', undefined],
    ['advance with currency', PREPAYMENT, 'target.currency', 'EUR'],
    ['advance without record', PREPAYMENT, 'target.advance', null],
    ['advance bad kind', PREPAYMENT, 'target.advanceKind', 'employee'],
    ['advance bad date', PREPAYMENT, 'target.advance.date', ''],
    [
      'advance missing flag',
      PREPAYMENT,
      'target.advance.needsReview',
      undefined,
    ],
    [
      'funding line bad date',
      PREPAYMENT,
      'target.advance.fundingLine.transactionDate',
      null,
    ],
    [
      'funding line object reference',
      PREPAYMENT,
      'target.advance.fundingLine.reference',
      {},
    ],
    [
      'funding line missing description',
      PREPAYMENT,
      'target.advance.fundingLine.description',
      undefined,
    ],
    [
      'funding line no amount',
      PREPAYMENT,
      'target.advance.fundingLine.amount',
      undefined,
    ],
    ['unidentified with id', UNIDENTIFIED, 'target.objectId', 3],
    ['unidentified with currency', UNIDENTIFIED, 'target.currency', undefined],
    ['unidentified with advance', UNIDENTIFIED, 'target.advance', {}],
  ])('rejects %s without handing out display facts', (_n, f, path, value) => {
    const r = checkMatchFacts(
      path === 'target' ? { ...f, target: value } : withField(f, path, value),
      APPROVAL,
    );
    expect(r.ok).toBe(false);
    expect(r.facts).toBeNull();
  });

  it('blocks an advance whose party is unknown even if flagged resolved', () => {
    const r = checkMatchFacts(
      withField(PREPAYMENT, 'target.counterpartyName', null),
      APPROVAL,
    );
    expect(r.ok).toBe(false);
  });
});
