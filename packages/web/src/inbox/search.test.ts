import { describe, expect, it } from 'vitest';
import type { Approval, Entity, Expense, SalesInvoice } from '../api';
import { buildQueue, type InboxEntry } from '../queries/inbox';
import { searchNeedle } from '../lib/searchText';
import { inboxEntryMatches, titleOnlyApproval } from './search';

const AT = Math.floor(new Date('2026-07-07T10:00:00').getTime() / 1000);

const approval = (id: number, object_type: string, object_id: number) =>
  ({
    id,
    object_type,
    object_id,
    status: 'pending',
    requested_by: 'system:policy',
    approved_by: null,
    rejected_reason: null,
    policy_reason: null,
    superseded_by: null,
    created_at: AT,
    resolved_at: null,
  }) as Approval;

const facts = {
  expenses: [
    {
      id: 214,
      supplier_id: 3,
      category: 'software',
      gross_amount: 8900,
      supplier_invoice_number: 'TL-2026/07  A',
    },
  ] as Expense[],
  invoices: [
    {
      id: 18,
      customer_id: 4,
      invoice_number: '2026-018',
      gross_amount: 120000,
    },
  ] as SalesInvoice[],
  entities: [
    { id: 3, name: 'Telia Eesti AS' },
    { id: 4, name: 'Nordic Consulting OÜ' },
  ] as Entity[],
};
const noFacts = { expenses: [], invoices: [], entities: [] };

const queue = buildQueue(
  [
    {
      id: 12,
      filename: 'cheque_scan_038.jpg',
      created_at: AT,
      reason: '',
      reason_type: 'low_confidence',
    },
  ],
  [
    approval(7, 'expense', 214),
    approval(8, 'sales_invoice', 18),
    approval(9, 'reconciliation_match', 41),
  ],
  'all',
);
const byRoute = (r: string) => queue.find((e) => e.route === r) as InboxEntry;
const hits = (q: string, f = facts) => {
  const needle = searchNeedle(q);
  if (needle === null) throw new Error('no needle');
  return queue
    .filter((e) => inboxEntryMatches(e, needle, f))
    .map((e) => e.route);
};

describe('inboxEntryMatches (issue #278)', () => {
  it('triage documents: file name only (no supplier/amount before classification)', () => {
    expect(hits('CHEQUE_scan')).toEqual(['/inbox/doc/12']);
    expect(hits('038')).toEqual(['/inbox/doc/12']);
  });

  it('expense approvals: supplier, supplier invoice number, amount', () => {
    expect(hits('telia')).toEqual(['/inbox/approval/7']);
    expect(hits('tl-2026/07 a')).toEqual(['/inbox/approval/7']);
    expect(hits('89,00')).toEqual(['/inbox/approval/7']);
  });

  it('sales invoice approvals: customer, invoice number, amount', () => {
    expect(hits('nordic')).toEqual(['/inbox/approval/8']);
    expect(hits('2026-018')).toEqual(['/inbox/approval/8']);
    expect(hits('1200')).toEqual(['/inbox/approval/8']);
  });

  it('bank-match approvals: title only — no amount or counterparty', () => {
    expect(hits('bank match')).toEqual(['/inbox/approval/9']);
    expect(titleOnlyApproval(byRoute('/inbox/approval/9'))).toBe(true);
    expect(titleOnlyApproval(byRoute('/inbox/approval/7'))).toBe(false);
    expect(titleOnlyApproval(byRoute('/inbox/doc/12'))).toBe(false);
  });

  it('every entry by arrival date', () => {
    expect(hits('7 jul 2026')).toHaveLength(4);
    expect(hits('2026-07-08')).toEqual([]);
  });

  it('approvals whose facts are not loaded cannot match by name or amount', () => {
    expect(hits('telia', noFacts)).toEqual([]);
    expect(hits('89', noFacts)).toEqual([]);
    // Their fallback titles still match.
    expect(hits('expense', noFacts)).toEqual(['/inbox/approval/7']);
  });
});
