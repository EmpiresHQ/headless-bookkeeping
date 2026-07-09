import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import type { DocumentArchiveRow, Expense, SalesInvoice } from '../api';
import {
  booksKeys,
  documentedExpenseIds,
  expenseMatchesQuery,
  groupByMonth,
  invalidateBooks,
  invoiceMatchesQuery,
  matchesStatus,
  monthLabel,
  newestRejection,
  remainingCreditable,
  shortDate,
} from './books';

const exp = (o: Partial<Expense>): Expense => ({
  id: 1,
  supplier_id: null,
  category: 'fuel',
  gross_amount: 4820,
  vat_amount: 869,
  currency: 'EUR',
  tax_point_date: '2026-07-01',
  supplier_invoice_number: null,
  status: 'posted',
  reconciled: false,
  ...o,
});

describe('books pure model', () => {
  it('groups by tax_point_date month, newest month first, newest row first, with totals under the ACTIVE filter', () => {
    const rows = [
      exp({ id: 1, tax_point_date: '2026-06-25', gross_amount: 65000 }),
      exp({ id: 2, tax_point_date: '2026-07-03', gross_amount: 8900 }),
      exp({ id: 3, tax_point_date: '2026-07-01', gross_amount: 4820 }),
    ];
    const groups = groupByMonth(rows);
    expect(groups.map((g) => g.month)).toEqual(['2026-07', '2026-06']);
    expect(groups[0].rows.map((r) => r.id)).toEqual([2, 3]);
    expect(groups[0].totalCents).toBe(13720);
    expect(groups[0].count).toBe(2);
    expect(groups[1].totalCents).toBe(65000);
  });

  it('monthLabel and shortDate are pure string math (timezone-proof)', () => {
    expect(monthLabel('2026-07')).toBe('July 2026');
    expect(shortDate('2026-07-03')).toBe('3 Jul');
  });

  it('matchesStatus maps the corrected chip onto the reversed status', () => {
    expect(matchesStatus(exp({ status: 'reversed' }), 'corrected')).toBe(true);
    expect(matchesStatus(exp({ status: 'posted' }), 'corrected')).toBe(false);
    expect(matchesStatus(exp({ status: 'draft' }), 'all')).toBe(true);
    expect(matchesStatus(exp({ status: 'draft' }), 'draft')).toBe(true);
  });

  it('expenseMatchesQuery searches supplier name, category and amount', () => {
    const row = exp({ category: 'software', gross_amount: 8900 });
    expect(expenseMatchesQuery(row, 'telia', 'Telia Eesti AS')).toBe(true);
    expect(expenseMatchesQuery(row, 'soft', null)).toBe(true);
    expect(expenseMatchesQuery(row, '89.00', null)).toBe(true);
    expect(expenseMatchesQuery(row, 'bolt', 'Telia Eesti AS')).toBe(false);
    expect(expenseMatchesQuery(row, '', null)).toBe(true);
  });

  it('invoiceMatchesQuery searches customer name, invoice number, and amount', () => {
    const inv: SalesInvoice = {
      id: 3,
      customer_id: 7,
      invoice_number: '2026-018',
      gross_amount: 120000,
      vat_amount: 21639,
      currency: 'EUR',
      tax_point_date: '2026-07-04',
      due_date: null,
      document_id: null,
      status: 'posted',
      sent_at: null,
      reconciled: false,
    };
    // Number arm:
    expect(invoiceMatchesQuery(inv, '2026-018', null)).toBe(true);
    expect(invoiceMatchesQuery(inv, '2026-099', null)).toBe(false);
    // Amount arm:
    expect(invoiceMatchesQuery(inv, '1200.00', null)).toBe(true);
    expect(invoiceMatchesQuery(inv, '999.99', 'Nordic Consulting OÜ')).toBe(
      false,
    );
    // Customer-name arm, and the empty-query pass-through:
    expect(invoiceMatchesQuery(inv, 'nordic', 'Nordic Consulting OÜ')).toBe(
      true,
    );
    expect(invoiceMatchesQuery(inv, '', null)).toBe(true);
  });

  it('documentedExpenseIds joins the archive (waiting-for-document marker)', () => {
    const docs = [
      { id: 1, expense_id: 12 },
      { id: 2, expense_id: null },
      { id: 3, expense_id: 14 },
    ] as DocumentArchiveRow[];
    const set = documentedExpenseIds(docs);
    expect(set.has(12)).toBe(true);
    expect(set.has(13)).toBe(false);
  });

  it('newestRejection picks the latest resolved rejection for the object', () => {
    const mk = (id: number, object_id: number, resolved_at: number | null) => ({
      id,
      object_type: 'expense' as const,
      object_id,
      status: 'rejected',
      requested_by: 'system',
      approved_by: null,
      rejected_reason: `r${id}`,
      policy_reason: null,
      superseded_by: null,
      created_at: 0,
      resolved_at,
    });
    const rows = [mk(1, 5, 100), mk(2, 5, 200), mk(3, 6, 300)];
    expect(newestRejection(rows, 5)?.rejected_reason).toBe('r2');
    expect(newestRejection(rows, 7)).toBeNull();
  });

  it('remainingCreditable subtracts POSTED notes for the object only', () => {
    const notes = [
      {
        credits_object_type: 'sales_invoice',
        credits_object_id: 3,
        status: 'posted',
        gross_amount: 4000,
      },
      {
        credits_object_type: 'sales_invoice',
        credits_object_id: 3,
        status: 'draft',
        gross_amount: 9999,
      },
      {
        credits_object_type: 'expense',
        credits_object_id: 3,
        status: 'posted',
        gross_amount: 500,
      },
    ];
    expect(remainingCreditable(12000, notes as never, 'sales_invoice', 3)).toBe(
      8000,
    );
  });

  it('invalidateBooks invalidates books + shared lists + inbox', async () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    await invalidateBooks(qc);
    const keys = spy.mock.calls.map((c) => c[0]?.queryKey);
    expect(keys).toContainEqual(booksKeys.all);
    expect(keys).toContainEqual(['expenses']);
    expect(keys).toContainEqual(['invoices']);
    expect(keys).toContainEqual(['inbox']);
  });
});
