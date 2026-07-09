import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  getNeedsTriageItems: vi.fn(),
  getPendingApprovals: vi.fn(),
  getExpense: vi.fn(),
}));

import * as api from '../api';
import type { Approval, Expense, NeedsTriageItem } from '../api';
import { sharedKeys } from './keys';
import {
  INBOX_REFETCH_MS,
  approvalDisplay,
  buildQueue,
  inboxKeys,
  inboxRefetchInterval,
  invalidateInbox,
  nextRouteAfter,
  openPeriod,
  periodExpensesTotal,
  queuePosition,
  splitTodayEarlier,
  useInboxCount,
  useNeedsTriage,
} from './inbox';

const T = (id: number, createdAt: number): NeedsTriageItem => ({
  id,
  filename: `doc-${id}.pdf`,
  created_at: createdAt,
  reason: 'AI confidence 0.41 below threshold 0.8',
  reason_type: 'low_confidence',
});

const A = (
  id: number,
  createdAt: number,
  over: Partial<Approval> = {},
): Approval => ({
  id,
  object_type: 'expense',
  object_id: 100 + id,
  status: 'pending',
  requested_by: 'system:policy',
  approved_by: null,
  rejected_reason: null,
  policy_reason: 'Voucher amount 8900 exceeds ceiling 5000',
  superseded_by: null,
  created_at: createdAt,
  resolved_at: null,
  ...over,
});

function makeWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, wrapper };
}

describe('polling seam', () => {
  it('polls 30s only for Inbox-route observers', () => {
    expect(inboxRefetchInterval(true)).toBe(INBOX_REFETCH_MS);
    expect(INBOX_REFETCH_MS).toBe(30_000);
    expect(inboxRefetchInterval(false)).toBe(false);
  });
});

describe('buildQueue', () => {
  const triage = [T(1, 300), T(2, 100)];
  const approvals = [A(7, 200)];

  it('merges both sources FIFO oldest-first', () => {
    const q = buildQueue(triage, approvals, 'all');
    expect(q.map((e) => e.route)).toEqual([
      '/inbox/doc/2',
      '/inbox/approval/7',
      '/inbox/doc/1',
    ]);
  });

  it('filters by segment', () => {
    expect(
      buildQueue(triage, approvals, 'triage').every((e) => e.kind === 'triage'),
    ).toBe(true);
    expect(buildQueue(triage, approvals, 'approvals')).toHaveLength(1);
  });
});

describe('sections and progress', () => {
  const now = new Date('2026-07-09T10:00:00');
  const todayTs = Math.floor(new Date('2026-07-09T08:00:00').getTime() / 1000);
  const oldTs = Math.floor(new Date('2026-07-07T08:00:00').getTime() / 1000);
  const entries = buildQueue([T(1, oldTs), T(2, todayTs)], [], 'all');

  it('splits Today from Earlier at local midnight', () => {
    const { today, earlier } = splitTodayEarlier(entries, now);
    expect(today.map((e) => e.route)).toEqual(['/inbox/doc/2']);
    expect(earlier.map((e) => e.route)).toEqual(['/inbox/doc/1']);
  });

  it('computes N of M for a detail route', () => {
    expect(queuePosition(entries, '/inbox/doc/1')).toEqual({
      pos: 1,
      total: 2,
    });
    expect(queuePosition(entries, '/inbox/doc/999')).toBeNull();
  });

  it('advances to the next pending, else previous, else the queue', () => {
    expect(nextRouteAfter(entries, '/inbox/doc/1')).toBe('/inbox/doc/2');
    expect(nextRouteAfter(entries, '/inbox/doc/2')).toBe('/inbox/doc/1');
    expect(nextRouteAfter([entries[0]], '/inbox/doc/1')).toBe('/inbox');
    expect(nextRouteAfter(entries, '/inbox/doc/404')).toBe('/inbox');
  });
});

describe('approvalDisplay', () => {
  const entities = [
    {
      id: 3,
      role: 'supplier',
      country: 'EE',
      name: 'Telia Eesti AS',
      goods_vs_services: null,
    },
    {
      id: 4,
      role: 'customer',
      country: 'EE',
      name: 'Nordic Consulting',
      goods_vs_services: null,
    },
  ];
  const expenses = [
    {
      id: 107,
      supplier_id: 3,
      category: 'software',
      gross_amount: 8900,
      vat_amount: 1632,
      currency: 'EUR',
      tax_point_date: '2026-07-03',
      status: 'pending',
      reconciled: false,
    },
  ];
  const invoices = [
    {
      id: 55,
      customer_id: 4,
      invoice_number: '2026-018',
      gross_amount: 120000,
      vat_amount: 0,
      currency: 'EUR',
      tax_point_date: '2026-07-01',
      status: 'pending',
      sent_at: null,
      reconciled: false,
    },
  ];

  it('titles an expense approval with the supplier and a negative amount', () => {
    expect(approvalDisplay(A(7, 1), { expenses, invoices, entities })).toEqual({
      title: 'Telia Eesti AS',
      amountCents: -8900,
    });
  });

  it('titles an invoice approval with the customer and a positive amount', () => {
    const a = A(8, 1, { object_type: 'sales_invoice', object_id: 55 });
    expect(approvalDisplay(a, { expenses, invoices, entities })).toEqual({
      title: 'Nordic Consulting',
      amountCents: 120000,
    });
  });

  it('renders reconciliation_match and allowance safely', () => {
    const m = A(9, 1, {
      object_type: 'reconciliation_match',
      object_id: 41,
      policy_reason: null,
    });
    expect(approvalDisplay(m, { expenses, invoices, entities })).toEqual({
      title: 'Bank match',
      amountCents: null,
    });
    const al = A(10, 1, { object_type: 'allowance', object_id: 5 });
    expect(approvalDisplay(al, { expenses, invoices, entities }).title).toBe(
      'Allowance',
    );
  });

  it('falls back to the category when the expense row is not in the list yet', () => {
    expect(
      approvalDisplay(A(7, 1), { expenses: [], invoices, entities }).title,
    ).toBe('Expense');
  });
});

describe('hooks', () => {
  beforeEach(() => vi.clearAllMocks());

  it('useNeedsTriage re-sorts the newest-first server list to FIFO', async () => {
    vi.mocked(api.getNeedsTriageItems).mockResolvedValue([
      T(1, 300),
      T(2, 100),
    ]);
    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useNeedsTriage(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.map((i) => i.id)).toEqual([2, 1]);
  });

  it('useInboxCount sums both queues without polling', async () => {
    vi.mocked(api.getNeedsTriageItems).mockResolvedValue([T(1, 1), T(2, 2)]);
    vi.mocked(api.getPendingApprovals).mockResolvedValue([A(7, 3)]);
    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useInboxCount(), { wrapper });
    await waitFor(() => expect(result.current).toBe(3));
  });
});

describe('invalidateInbox', () => {
  it('invalidates the queue, expenses, invoices, AND entities', async () => {
    // ResolveSupplierSheet creates suppliers on the triage path, and queue
    // titles/facts/pickers join against entities — a stale entities cache
    // would show the pre-creation "unknown supplier" state after resolving.
    const { client } = makeWrapper();
    const spy = vi.spyOn(client, 'invalidateQueries');
    await invalidateInbox(client);
    const keys = spy.mock.calls.map(([arg]) => arg?.queryKey);
    expect(keys).toEqual(
      expect.arrayContaining([
        inboxKeys.all,
        sharedKeys.expenses,
        sharedKeys.invoices,
        sharedKeys.entities,
      ]),
    );
  });
});

describe('hero data', () => {
  const period = {
    id: 1,
    name: 'July 2026',
    start_date: '2026-07-01',
    end_date: '2026-07-31',
    status: 'open',
    filed_at: null,
  };
  // Typed Partial so the spread keeps the Expense shape (a Record spread
  // would widen the fields). Add `Expense` to the api type imports.
  const expense = (over: Partial<Expense> = {}): Expense => ({
    id: 1,
    supplier_id: null,
    category: 'software',
    gross_amount: 1000,
    vat_amount: 0,
    currency: 'EUR',
    tax_point_date: '2026-07-03',
    status: 'posted',
    reconciled: false,
    ...over,
  });

  it('openPeriod picks the latest open period and ignores locked ones', () => {
    expect(
      openPeriod([
        {
          ...period,
          id: 2,
          name: 'June',
          start_date: '2026-06-01',
          end_date: '2026-06-30',
          status: 'locked',
        },
        period,
      ])?.name,
    ).toBe('July 2026');
    expect(openPeriod([{ ...period, status: 'locked' }])).toBeNull();
    expect(openPeriod([])).toBeNull();
  });

  it('periodExpensesTotal sums posted+pending inside the period only', () => {
    const total = periodExpensesTotal(
      [
        expense({ id: 1, gross_amount: 8900 }),
        expense({ id: 2, gross_amount: 4820, status: 'pending' }),
        expense({ id: 3, gross_amount: 999, status: 'draft' }), // not money yet
        expense({ id: 4, gross_amount: 5000, tax_point_date: '2026-06-30' }), // out of period
      ],
      period,
    );
    expect(total).toBe(13720);
  });
});
