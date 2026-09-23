import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import {
  MemoryRouter,
  Route,
  Routes,
  RouterProvider,
  createBrowserRouter,
} from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api', async (io) => ({
  ...(await io<typeof import('../api')>()),
  getReportingPeriods: vi.fn(),
  getPeriodWarnings: vi.fn(),
  getPendingApprovals: vi.fn(),
  getExpenses: vi.fn(),
  getInvoices: vi.fn(),
  getEntities: vi.fn(),
  getExpense: vi.fn(),
  getDocuments: vi.fn(),
  listApprovals: vi.fn(),
  getCategories: vi.fn(),
  deleteExpense: vi.fn(),
}));
import * as api from '../api';
import type { Approval, PeriodWarning } from '../api';
import { setToken } from '../auth';
import { absoluteDateFromIso } from '../inbox/format';
import { ExpenseScreen } from '../books/ExpenseScreen';
import { UnsavedChangesProvider } from '../lib/unsavedChanges';
import { reportsKeys } from '../queries/reports';
import { AppLayout } from '../shell/AppLayout';
import { AppToaster } from '../ui/toast';
import {
  approvalFor,
  bucketOf,
  bucketWarnings,
  parsePeriodItemsPath,
  periodItemsHref,
} from './periodItems';
import { PeriodItemsScreen } from './PeriodItemsScreen';

const SEPT = {
  id: 9,
  name: '2026-09',
  start_date: '2026-09-01',
  end_date: '2026-09-30',
  status: 'open',
  filed_at: null,
};
const AUG_LOCKED = {
  id: 8,
  name: '2026-08',
  start_date: '2026-08-01',
  end_date: '2026-08-31',
  status: 'locked',
  filed_at: 1757000000,
};

const W = (
  type: string,
  object_type: string,
  object_id: number,
): PeriodWarning =>
  ({
    type,
    object_type,
    object_id,
    description: `raw EUR 99999 #${object_id}`,
  }) as PeriodWarning;

const APPROVAL = (
  id: number,
  object_type: string,
  object_id: number,
  status = 'pending',
): Approval => ({
  id,
  object_type,
  object_id,
  status,
  requested_by: 'system:policy',
  approved_by: null,
  rejected_reason: null,
  policy_reason: null,
  superseded_by: null,
  created_at: id,
  resolved_at: null,
});

const EXPENSE = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  supplier_id: 3,
  category: 'rent',
  gross_amount: 12200,
  vat_amount: 2200,
  currency: 'EUR',
  tax_point_date: '2026-09-10',
  status: 'draft',
  reconciled: false,
  supplier_invoice_number: null,
  ...over,
});

const INVOICE = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  customer_id: 4,
  invoice_number: `INV-${id}`,
  gross_amount: 50000,
  vat_amount: 9000,
  currency: 'EUR',
  tax_point_date: '2026-09-12',
  due_date: null,
  document_id: null,
  status: 'pending',
  sent_at: null,
  supply_type: null,
  service_place_rule: 'general',
  reconciled: false,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getReportingPeriods).mockResolvedValue([
    SEPT,
    AUG_LOCKED,
  ] as never);
  vi.mocked(api.getPeriodWarnings).mockResolvedValue([]);
  vi.mocked(api.getPendingApprovals).mockResolvedValue([]);
  vi.mocked(api.getExpenses).mockResolvedValue([] as never);
  vi.mocked(api.getInvoices).mockResolvedValue([] as never);
  vi.mocked(api.getEntities).mockResolvedValue([
    { id: 3, role: 'supplier', country: 'EE', name: 'AS Merko' },
    { id: 4, role: 'customer', country: 'EE', name: 'OÜ Klient' },
  ] as never);
});

describe('period drill-down model', () => {
  it('joins approvals by the exact typed pair — expense 12 ≠ invoice 12, bank matches never', () => {
    const approvals = [
      APPROVAL(101, 'expense', 12),
      APPROVAL(202, 'sales_invoice', 12),
      APPROVAL(303, 'reconciliation_match', 12),
      APPROVAL(404, 'expense', 13, 'approved'),
    ];
    expect(
      approvalFor(W('pending_approval', 'expense', 12), approvals)?.id,
    ).toBe(101);
    expect(
      approvalFor(W('pending_approval', 'sales_invoice', 12), approvals)?.id,
    ).toBe(202);
    // Not an approval ID, and a resolved approval is not a pending one.
    expect(approvalFor(W('pending_approval', 'expense', 13), approvals)).toBe(
      null,
    );
    expect(approvalFor(W('pending_approval', 'expense', 303), approvals)).toBe(
      null,
    );
  });

  it('buckets by type + object type; unknown shapes land in other, never dropped', () => {
    const ws = [
      W('pending_approval', 'expense', 1),
      W('unposted_draft', 'expense', 2),
      W('unposted_draft', 'sales_invoice', 3),
      W('stale_match', 'reconciliation_match', 4),
      W('unposted_draft', 'allowance', 5),
    ];
    expect(ws.map(bucketOf)).toEqual([
      'approvals',
      'expense-drafts',
      'invoice-drafts',
      'other',
      'other',
    ]);
    expect(bucketWarnings(ws, 'other').map((w) => w.object_id)).toEqual([4, 5]);
  });

  it('round-trips the scoped path and rejects anything else', () => {
    expect(periodItemsHref(9, 'expense-drafts')).toBe(
      '/reports/periods/9/undecided/expense-drafts',
    );
    expect(
      parsePeriodItemsPath('/reports/periods/9/undecided/approvals'),
    ).toEqual({ periodId: 9, bucket: 'approvals' });
    expect(parsePeriodItemsPath('/reports/periods/9/undecided/nope')).toBe(
      null,
    );
    expect(parsePeriodItemsPath('/reports/periods/0/undecided/other')).toBe(
      null,
    );
    expect(parsePeriodItemsPath('/reports/periods/9')).toBe(null);
  });
});

function mount(path: string, qc = newClient()) {
  render(
    <QueryClientProvider client={qc}>
      <UnsavedChangesProvider onUnauthorized={() => undefined}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route
              path="/reports/periods/:id/undecided/:bucket"
              element={<PeriodItemsScreen />}
            />
          </Routes>
        </MemoryRouter>
      </UnsavedChangesProvider>
    </QueryClientProvider>,
  );
  return qc;
}

function newClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

const rowLinks = () =>
  screen
    .queryAllByRole('link')
    .map((a) => a.getAttribute('href'))
    .filter((h) => h?.startsWith('/inbox') || h?.startsWith('/books'));

describe('PeriodItemsScreen', () => {
  it('approvals: exactly this period’s typed objects, each to its own pending approval', async () => {
    vi.mocked(api.getPeriodWarnings).mockResolvedValue([
      W('pending_approval', 'expense', 12),
      W('pending_approval', 'sales_invoice', 12),
      W('unposted_draft', 'expense', 30),
    ]);
    vi.mocked(api.getPendingApprovals).mockResolvedValue([
      APPROVAL(101, 'expense', 12),
      APPROVAL(202, 'sales_invoice', 12),
      APPROVAL(303, 'reconciliation_match', 12),
      APPROVAL(505, 'expense', 25), // another period's object
    ]);
    vi.mocked(api.getExpenses).mockResolvedValue([
      EXPENSE(12, { status: 'pending' }),
      EXPENSE(25, { status: 'pending', tax_point_date: '2026-08-20' }),
    ] as never);
    vi.mocked(api.getInvoices).mockResolvedValue([INVOICE(12)] as never);
    mount('/reports/periods/9/undecided/approvals');

    expect(
      await screen.findByText(/September 2026 · Awaiting approval/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(new RegExp(absoluteDateFromIso('2026-09-01'))),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(rowLinks().sort()).toEqual([
        '/inbox/approval/101',
        '/inbox/approval/202',
      ]),
    );
    expect(screen.getByText('Approval #101')).toBeInTheDocument();
    expect(screen.getByText('Approval #202')).toBeInTheDocument();
    expect(screen.queryByText(/303|505/)).toBeNull();
    expect(screen.queryByText(/EUR 99999/)).toBeNull();
    expect(
      screen.getByRole('link', { name: 'Return to September 2026' }),
    ).toHaveAttribute('href', '/reports/periods/9');
  });

  it('no matching pending approval: stated, opens the Books record — no invented approval', async () => {
    vi.mocked(api.getPeriodWarnings).mockResolvedValue([
      W('pending_approval', 'sales_invoice', 12),
    ]);
    vi.mocked(api.getPendingApprovals).mockResolvedValue([
      APPROVAL(101, 'expense', 12),
    ]);
    vi.mocked(api.getInvoices).mockResolvedValue([INVOICE(12)] as never);
    mount('/reports/periods/9/undecided/approvals');
    expect(await screen.findByText('No approval')).toBeInTheDocument();
    expect(rowLinks()).toEqual(['/books/invoices/12']);
  });

  it('approvals failure: row kept, Retry offered, no-match never claimed', async () => {
    vi.mocked(api.getPeriodWarnings).mockResolvedValue([
      W('pending_approval', 'expense', 12),
    ]);
    vi.mocked(api.getPendingApprovals).mockRejectedValue(new Error('boom'));
    vi.mocked(api.getExpenses).mockResolvedValue([EXPENSE(12)] as never);
    mount('/reports/periods/9/undecided/approvals');
    expect(await screen.findByText('Approval unknown')).toBeInTheDocument();
    expect(
      screen.getByText(/Couldn't check the matching approvals — boom/),
    ).toBeInTheDocument();
    expect(screen.queryByText('No approval')).toBeNull();
    expect(rowLinks()).toEqual(['/books/expenses/12']);

    vi.mocked(api.getPendingApprovals).mockResolvedValue([
      APPROVAL(101, 'expense', 12),
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Approval #101')).toBeInTheDocument();
  });

  it('cached approvals whose refresh fails: a no-match is unconfirmed, not current', async () => {
    vi.mocked(api.getPeriodWarnings).mockResolvedValue([
      W('pending_approval', 'expense', 12),
    ]);
    vi.mocked(api.getPendingApprovals).mockRejectedValue(new Error('down'));
    const qc = newClient();
    qc.setQueryData(['inbox', 'approvals', 'pending'], []);
    mount('/reports/periods/9/undecided/approvals', qc);
    expect(
      await screen.findByText(/Couldn't refresh the matching approvals/),
    ).toBeInTheDocument();
    expect(screen.getByText('Unconfirmed')).toBeInTheDocument();
    expect(screen.queryByText('No approval')).toBeNull();
  });

  it('drafts render each object in its OWN currency', async () => {
    vi.mocked(api.getPeriodWarnings).mockResolvedValue([
      W('unposted_draft', 'expense', 7),
    ]);
    vi.mocked(api.getExpenses).mockResolvedValue([
      EXPENSE(7, { currency: 'USD', gross_amount: 4500 }),
    ] as never);
    mount('/reports/periods/9/undecided/expense-drafts');
    expect(await screen.findByText('AS Merko')).toBeInTheDocument();
    expect(screen.getByText(/45\.00 USD/)).toBeInTheDocument();
    expect(screen.queryByText(/€/)).toBeNull();
    expect(rowLinks()).toEqual(['/books/expenses/7']);
  });

  it('Books list failure keeps the warned rows (membership is the check) with Retry', async () => {
    vi.mocked(api.getPeriodWarnings).mockResolvedValue([
      W('unposted_draft', 'sales_invoice', 5),
    ]);
    vi.mocked(api.getInvoices).mockRejectedValue(new Error('books down'));
    mount('/reports/periods/9/undecided/invoice-drafts');
    expect(await screen.findByText('No details')).toBeInTheDocument();
    expect(screen.getByText('Invoice #5')).toBeInTheDocument();
    expect(
      screen.getByText(/Couldn't check item details — books down/),
    ).toBeInTheDocument();
    expect(rowLinks()).toEqual(['/books/invoices/5']);
  });

  it('a warned object missing from a CURRENT Books list says so; from a stale one, unconfirmed', async () => {
    vi.mocked(api.getPeriodWarnings).mockResolvedValue([
      W('unposted_draft', 'expense', 40),
    ]);
    mount('/reports/periods/9/undecided/expense-drafts');
    expect(await screen.findByText('Not in Books')).toBeInTheDocument();
  });

  it('missing object in a cached list whose refresh failed is not proof of deletion', async () => {
    vi.mocked(api.getPeriodWarnings).mockResolvedValue([
      W('unposted_draft', 'expense', 40),
    ]);
    vi.mocked(api.getExpenses).mockRejectedValue(new Error('flaky'));
    const qc = newClient();
    qc.setQueryData(['expenses'], []);
    await act(() => qc.invalidateQueries({ queryKey: ['expenses'] }));
    mount('/reports/periods/9/undecided/expense-drafts', qc);
    expect(await screen.findByText('Unconfirmed')).toBeInTheDocument();
    expect(screen.queryByText('Not in Books')).toBeNull();
  });

  it('empty after a CURRENT check reads Resolved with the way back; the count re-checks live', async () => {
    vi.mocked(api.getPeriodWarnings).mockResolvedValue([
      W('unposted_draft', 'expense', 7),
    ]);
    vi.mocked(api.getExpenses).mockResolvedValue([EXPENSE(7)] as never);
    const qc = mount('/reports/periods/9/undecided/expense-drafts');
    expect(await screen.findByText('AS Merko')).toBeInTheDocument();

    // The item was posted elsewhere: Books/Inbox invalidate ['reports'].
    vi.mocked(api.getPeriodWarnings).mockResolvedValue([]);
    await act(() => qc.invalidateQueries({ queryKey: reportsKeys.all }));
    expect(await screen.findByText('Resolved')).toBeInTheDocument();
    expect(screen.queryByText('AS Merko')).toBeNull();
    expect(
      screen.getByRole('link', { name: 'Return to September 2026' }),
    ).toBeInTheDocument();
  });

  it('warnings unavailable: stated with Retry — never Resolved', async () => {
    vi.mocked(api.getPeriodWarnings).mockRejectedValue(new Error('500'));
    mount('/reports/periods/9/undecided/approvals');
    expect(
      await screen.findByText(/Couldn't check items awaiting approval — 500/),
    ).toBeInTheDocument();
    expect(screen.queryByText('Resolved')).toBeNull();
  });

  it('stale cached warnings: rows kept but flagged, and an empty cache is not Resolved', async () => {
    vi.mocked(api.getPeriodWarnings).mockRejectedValue(new Error('offline'));
    const qc = newClient();
    qc.setQueryData(reportsKeys.warnings(9), []);
    mount('/reports/periods/9/undecided/approvals', qc);
    expect(
      await screen.findByText(/Couldn't refresh items awaiting approval/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /None in the last loaded result — not confirmed current/,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText('Resolved')).toBeNull();
  });

  it('unknown warning shapes stay visible and explicit', async () => {
    vi.mocked(api.getPeriodWarnings).mockResolvedValue([
      W('stale_match', 'reconciliation_match', 4),
    ]);
    mount('/reports/periods/9/undecided/other');
    expect(await screen.findByText('Unknown check')).toBeInTheDocument();
    expect(screen.getByText('reconciliation_match #4')).toBeInTheDocument();
    expect(rowLinks()).toEqual([]);
  });

  it('locked period: explained, no check fired', async () => {
    mount('/reports/periods/8/undecided/approvals');
    expect(
      await screen.findByText(/This period is closed/),
    ).toBeInTheDocument();
    expect(api.getPeriodWarnings).not.toHaveBeenCalled();
    expect(
      screen.getByRole('link', { name: 'Return to August 2026' }),
    ).toHaveAttribute('href', '/reports/periods/8');
  });

  it('invalid bucket or period: explicit, never a global list', async () => {
    mount('/reports/periods/9/undecided/everything');
    expect(
      await screen.findByText('This list does not exist'),
    ).toBeInTheDocument();
    expect(api.getPeriodWarnings).not.toHaveBeenCalled();
  });

  it('gate opening over FRESH cached data still re-checks (app staleTime, period loads late)', async () => {
    // App-like cache: 15 s staleTime, approvals + warnings already cached
    // fresh by the shell, the period list still unresolved at mount.
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 15_000 } },
    });
    qc.setQueryData(
      ['inbox', 'approvals', 'pending'],
      [APPROVAL(202, 'sales_invoice', 102)],
    );
    qc.setQueryData(reportsKeys.warnings(9), [
      W('pending_approval', 'expense', 101),
      W('pending_approval', 'sales_invoice', 102),
    ]);
    let releasePeriods: (v: unknown) => void = () => undefined;
    vi.mocked(api.getReportingPeriods).mockReturnValue(
      new Promise((r) => {
        releasePeriods = r;
      }) as never,
    );
    vi.mocked(api.getPeriodWarnings).mockResolvedValue([
      W('pending_approval', 'expense', 101),
      W('pending_approval', 'sales_invoice', 102),
    ]);
    vi.mocked(api.getPendingApprovals).mockResolvedValue([
      APPROVAL(202, 'sales_invoice', 102),
    ]);
    vi.mocked(api.getExpenses).mockResolvedValue([EXPENSE(101)] as never);
    vi.mocked(api.getInvoices).mockResolvedValue([INVOICE(102)] as never);
    mount('/reports/periods/9/undecided/approvals', qc);
    await act(async () => {
      releasePeriods([SEPT]);
      await Promise.resolve();
    });

    // Both gated reads re-check once enabled, and the join becomes CURRENT.
    expect(await screen.findByText('No approval')).toBeInTheDocument();
    expect(screen.getByText('Approval #202')).toBeInTheDocument();
    expect(api.getPendingApprovals).toHaveBeenCalledTimes(1);
    expect(api.getPeriodWarnings).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Unconfirmed')).toBeNull();
    expect(screen.queryByText(/Checking/)).toBeNull();
  });

  it('unknown period id: not found', async () => {
    mount('/reports/periods/77/undecided/approvals');
    expect(
      await screen.findByText('This period does not exist'),
    ).toBeInTheDocument();
  });
});

describe('period drill-down × real history (#252)', () => {
  let router: ReturnType<typeof createBrowserRouter> | null = null;
  afterEach(() => router?.dispose());

  function renderApp(path: string) {
    setToken('test-token');
    window.history.replaceState(null, '', path);
    router = createBrowserRouter([
      {
        element: (
          <AppLayout
            onSignOut={() => undefined}
            onUnauthorized={() => undefined}
          />
        ),
        children: [
          { path: '/books', element: <p>books list</p> },
          { path: '/books/expenses/:id', element: <ExpenseScreen /> },
          {
            path: '/reports/periods/:id/undecided/:bucket',
            element: <PeriodItemsScreen />,
          },
        ],
      },
    ]);
    render(
      <QueryClientProvider client={newClient()}>
        <RouterProvider router={router} />
        <AppToaster />
      </QueryClientProvider>,
    );
  }

  it('deleting a draft opened from the period list returns to that list, not global Books', async () => {
    let drafts = [EXPENSE(7)];
    vi.mocked(api.getPeriodWarnings).mockImplementation(() =>
      Promise.resolve(drafts.map((d) => W('unposted_draft', 'expense', d.id))),
    );
    vi.mocked(api.getExpenses).mockImplementation(() =>
      Promise.resolve(drafts as never),
    );
    vi.mocked(api.getExpense).mockResolvedValue({
      ...EXPENSE(7),
      document_id: null,
      ai_confidence: null,
      claimant_id: null,
      created_at: 1,
    } as never);
    vi.mocked(api.getDocuments).mockResolvedValue([] as never);
    vi.mocked(api.listApprovals).mockResolvedValue([] as never);
    vi.mocked(api.getCategories).mockResolvedValue([] as never);
    vi.mocked(api.deleteExpense).mockImplementation(() => {
      drafts = [];
      return Promise.resolve({ id: 7 } as never);
    });

    const list = '/reports/periods/9/undecided/expense-drafts';
    renderApp(list);
    fireEvent.click(await screen.findByText('AS Merko'));
    await waitFor(() =>
      expect(window.location.pathname).toBe('/books/expenses/7'),
    );
    expect(
      await screen.findByText(/Opened from September 2026 · expense drafts/),
    ).toBeInTheDocument();

    fireEvent.click(
      await screen.findByRole('button', { name: 'Delete draft…' }),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(window.location.pathname).toBe(list));
    expect(await screen.findByText('Resolved')).toBeInTheDocument();
    // Forward never revives the deleted draft.
    act(() => window.history.forward());
    await waitFor(() => expect(window.location.pathname).toBe(list));
  });
});
