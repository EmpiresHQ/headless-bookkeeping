import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { RouterProvider, createBrowserRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  getNeedsTriageItems: vi.fn(),
  getPendingApprovals: vi.fn(),
  listApprovals: vi.fn(),
  getExpense: vi.fn(),
  getExpenses: vi.fn(),
  getInvoices: vi.fn(),
  getEntities: vi.fn(),
  getDocuments: vi.fn(),
  getReportingPeriods: vi.fn(),
  getCategories: vi.fn(),
  getOrganization: vi.fn(),
  approveApproval: vi.fn(),
  rejectApproval: vi.fn(),
  postExpense: vi.fn(),
  getMatchFacts: vi.fn(),
  fetchDocumentPreviewObjectUrl: vi.fn(),
}));

import * as api from '../api';
import type { Approval, ExpenseDetail, SalesInvoice } from '../api';
import { setToken } from '../auth';
import { ApprovalScreen } from '../inbox/ApprovalScreen';
import { inboxKeys } from '../queries/inbox';
import { AppLayout } from '../shell/AppLayout';
import { AppToaster } from '../ui/toast';
import { ExpenseScreen } from './ExpenseScreen';
import { InvoiceScreen } from './InvoiceScreen';

/**
 * Issue #262 — a pending Books record leads to ITS OWN approval (exact typed
 * pair), opened as a single item whose origin is the record; absence and
 * failures are stated, never the global queue. Real jsdom history
 * (createBrowserRouter), app-like 15 s staleTime.
 */

const APPROVAL = (
  id: number,
  object_type: string,
  object_id: number,
  over: Partial<Approval> = {},
): Approval => ({
  id,
  object_type,
  object_id,
  status: 'pending',
  requested_by: 'system:policy',
  approved_by: null,
  rejected_reason: null,
  policy_reason: 'Voucher amount 65000 exceeds ceiling 5000',
  superseded_by: null,
  created_at: 100 + id,
  resolved_at: null,
  ...over,
});

// Same object id 12 for three different objects, plus an approval whose OWN
// id is 12 — none of them may be confused with the expense's approval 101.
const FIXTURE = (): Approval[] => [
  APPROVAL(12, 'expense', 99),
  APPROVAL(90, 'reconciliation_match', 12),
  APPROVAL(101, 'expense', 12),
  APPROVAL(102, 'sales_invoice', 12),
];

const EXPENSE = (status: string): ExpenseDetail => ({
  id: 12,
  document_id: null,
  supplier_id: null,
  category: 'rent',
  gross_amount: 65000,
  vat_amount: 11721,
  currency: 'EUR',
  tax_point_date: '2026-06-25',
  status,
  supplier_invoice_number: null,
  ai_confidence: null,
  claimant_id: null,
  created_at: 1750830000,
});

const INVOICE = (status: string): SalesInvoice => ({
  supply_type: null,
  service_place_rule: 'general',
  id: 12,
  customer_id: null,
  invoice_number: '2026-012',
  gross_amount: 120000,
  vat_amount: 21639,
  currency: 'EUR',
  tax_point_date: '2026-07-04',
  due_date: '2026-07-18',
  document_id: null,
  status,
  sent_at: null,
  reconciled: false,
});

let approvals: Approval[] = [];
let approvalsError: Error | null = null;
let expenseStatus = 'pending';
let invoiceStatus = 'pending';

function mockApi() {
  vi.mocked(api.getPendingApprovals).mockImplementation(() =>
    approvalsError !== null
      ? Promise.reject(approvalsError)
      : Promise.resolve(approvals),
  );
  vi.mocked(api.getNeedsTriageItems).mockResolvedValue([]);
  vi.mocked(api.listApprovals).mockResolvedValue([]);
  vi.mocked(api.getExpense).mockImplementation(() =>
    Promise.resolve(EXPENSE(expenseStatus)),
  );
  vi.mocked(api.getExpenses).mockImplementation(() =>
    Promise.resolve([
      { ...EXPENSE(expenseStatus), reconciled: false } as never,
    ]),
  );
  vi.mocked(api.getInvoices).mockImplementation(() =>
    Promise.resolve([INVOICE(invoiceStatus)]),
  );
  vi.mocked(api.getEntities).mockResolvedValue([]);
  vi.mocked(api.getDocuments).mockResolvedValue([]);
  vi.mocked(api.getReportingPeriods).mockResolvedValue([]);
  vi.mocked(api.getCategories).mockResolvedValue([]);
  vi.mocked(api.getOrganization).mockResolvedValue({ id: 1 } as never);
  vi.mocked(api.fetchDocumentPreviewObjectUrl).mockRejectedValue(
    new Error('no preview'),
  );
  // A decision resolves the approval and moves the object on (server).
  vi.mocked(api.approveApproval).mockImplementation((id: number) => {
    const a = approvals.find((x) => x.id === id);
    approvals = approvals.filter((x) => x.id !== id);
    if (a?.object_type === 'expense') expenseStatus = 'posted';
    if (a?.object_type === 'sales_invoice') invoiceStatus = 'posted';
    return Promise.resolve({} as never);
  });
  vi.mocked(api.rejectApproval).mockImplementation((id: number) => {
    const a = approvals.find((x) => x.id === id);
    approvals = approvals.filter((x) => x.id !== id);
    if (a?.object_type === 'expense') expenseStatus = 'draft';
    return Promise.resolve({} as never);
  });
}

const ROUTES = [
  {
    element: (
      <AppLayout onSignOut={() => undefined} onUnauthorized={() => undefined} />
    ),
    children: [
      { path: '/start', element: <p>start page</p> },
      { path: '/books', element: <p>books list</p> },
      { path: '/inbox', element: <p>inbox queue</p> },
      {
        path: '/reports/periods/:id/undecided/:bucket',
        element: <p>period list</p>,
      },
      { path: '/books/expenses/:id', element: <ExpenseScreen /> },
      { path: '/books/invoices/:id', element: <InvoiceScreen /> },
      { path: '/inbox/approval/:id', element: <ApprovalScreen /> },
    ],
  },
];

let routers: { dispose: () => void }[] = [];

function renderApp(path: string) {
  window.history.replaceState(null, '', path);
  const router = createBrowserRouter(ROUTES);
  routers.push(router);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 15_000 } },
  });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
      <AppToaster />
    </QueryClientProvider>,
  );
  return { router, client };
}

const here = () => window.location.pathname + window.location.search;
const idx = () => (window.history.state as { idx: number }).idx;

async function expectAt(href: string, at?: number) {
  await waitFor(() => {
    expect(here()).toBe(href);
    if (at !== undefined) expect(idx()).toBe(at);
  });
}

async function browserForward(href: string, at?: number) {
  act(() => window.history.forward());
  await expectAt(href, at);
}
async function browserBack(href: string, at?: number) {
  act(() => window.history.back());
  await expectAt(href, at);
}

/** /start → /books → the record (index 2). */
async function openRecord(path: string) {
  const app = renderApp('/start');
  await act(() => app.router.navigate('/books'));
  await act(() => app.router.navigate(path));
  await expectAt(path, 2);
  return app;
}

const openLink = (id: number) =>
  screen.findByRole('link', { name: `Open approval #${id}` });

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  setToken('test-token');
  approvals = FIXTURE();
  approvalsError = null;
  expenseStatus = 'pending';
  invoiceStatus = 'pending';
  mockApi();
});

afterEach(() => {
  for (const r of routers) r.dispose();
  routers = [];
  vi.clearAllMocks();
});

describe('pending Books record → its own approval (#262)', () => {
  it('expense 12 links approval 101 — not approval 12, invoice 12 or bank match 12; never the queue', async () => {
    await openRecord('/books/expenses/12');
    expect(await openLink(101)).toHaveAttribute('href', '/inbox/approval/101');
    expect(screen.getByText(/Waiting for approval #101/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Open Inbox/ })).toBeNull();
    // The shell's own nav links aside, the record offers no queue link.
    expect(
      document.querySelector('main a[href^="/inbox?"], main a[href="/inbox"]'),
    ).toBeNull();
  });

  it('invoice 12 links approval 102', async () => {
    await openRecord('/books/invoices/12');
    expect(await openLink(102)).toHaveAttribute('href', '/inbox/approval/102');
    expect(
      screen.queryByRole('link', { name: 'Open approval #101' }),
    ).toBeNull();
  });

  it('several pending for one object: the newest, deterministically', async () => {
    approvals = [...FIXTURE(), APPROVAL(104, 'expense', 12)];
    await openRecord('/books/expenses/12');
    expect(await openLink(104)).toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: 'Open approval #101' }),
    ).toBeNull();
  });

  it('opens as a single item and approve returns to the record — no finished approval in Forward', async () => {
    await openRecord('/books/expenses/12');
    fireEvent.click(await openLink(101));
    await expectAt('/inbox/approval/101', 3);
    expect(
      await screen.findByText('Single item · returns to Expense #12'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/\d+ of \d+/)).toBeNull();
    const approve = await screen.findByRole('button', {
      name: /^Approve · /,
    });
    await waitFor(() => expect(approve).toBeEnabled());
    fireEvent.click(approve);
    await expectAt('/books/expenses/12', 2);
    // The record re-reads its status after the decision.
    expect(
      await screen.findByText(/change it with a correction/),
    ).toBeInTheDocument();
    await browserForward('/books/expenses/12', 3);
    await browserBack('/books/expenses/12', 2);
    await browserBack('/books', 1);
  });

  it('a period-origin record keeps its own return notice across reject', async () => {
    const { router } = renderApp('/start');
    await act(() => router.navigate('/reports/periods/9/undecided/approvals'));
    const listIdx = idx();
    await act(() =>
      router.navigate('/books/expenses/12', {
        state: {
          hbkOrigin: {
            href: '/reports/periods/9/undecided/approvals',
            state: null,
            idx: listIdx,
            key: router.state.location.key,
          },
        },
      }),
    );
    expect(
      await screen.findByText(/Opened from period #9/),
    ).toBeInTheDocument();
    fireEvent.click(await openLink(101));
    await expectAt('/inbox/approval/101', 3);
    fireEvent.click(await screen.findByRole('button', { name: 'Reject…' }));
    fireEvent.change(
      await screen.findByPlaceholderText(/why this should not be posted/i),
      { target: { value: 'Wrong supplier' } },
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Reject & return to draft' }),
    );
    await expectAt('/books/expenses/12', 2);
    expect(
      await screen.findByText(/Opened from period #9/),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole('button', { name: 'Submit for posting' }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Return to list' }));
    await expectAt('/reports/periods/9/undecided/approvals', 1);
  });

  it('initial failure: stated with Retry, no link, no queue fallback; Retry recovers', async () => {
    approvalsError = new Error('approvals down');
    await openRecord('/books/expenses/12');
    expect(
      await screen.findByText("Couldn't find its approval — approvals down"),
    ).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Open approval/ })).toBeNull();
    expect(screen.queryByText(/No pending approval/)).toBeNull();
    approvalsError = null;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await openLink(101)).toBeInTheDocument();
  });

  it('cached list whose re-check fails: a cached no-match is not confirmed', async () => {
    // The shell's badge loads the list first (fresh cache), then the
    // server fails.
    approvals = [];
    const { router, client } = renderApp('/start');
    await waitFor(() =>
      expect(client.getQueryData(inboxKeys.approvals)).toEqual([]),
    );
    approvalsError = new Error('approvals down');
    await act(() => router.navigate('/books/expenses/12'));
    expect(
      await screen.findByText(
        /Couldn't refresh approvals — approvals down\. No pending approval for this expense in the last loaded list — not confirmed current\./,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/No pending approval found/)).toBeNull();
    expect(screen.queryByRole('link', { name: /Open approval/ })).toBeNull();
  });

  it('cached match whose re-check fails: still linked, marked as last loaded', async () => {
    // The shell's badge loads the list first (fresh cache), then the
    // server fails.
    approvals = FIXTURE();
    const { router, client } = renderApp('/start');
    await waitFor(() =>
      expect(client.getQueryData(inboxKeys.approvals)).toEqual(FIXTURE()),
    );
    approvalsError = new Error('approvals down');
    await act(() => router.navigate('/books/expenses/12'));
    expect(
      await screen.findByText(/Approval #101 is from the last loaded list/),
    ).toBeInTheDocument();
    expect(await openLink(101)).toBeInTheDocument();
  });

  it('fresh no-match: stated without claiming an outcome, and reloadable', async () => {
    approvals = FIXTURE().filter((a) => a.id !== 101);
    await openRecord('/books/expenses/12');
    expect(
      await screen.findByText(/No pending approval found for this expense/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/approved|posted/i)).toBeNull();
    // Bank match 12 / invoice 12 never stand in.
    expect(screen.queryByRole('link', { name: /Open approval/ })).toBeNull();
    approvals = FIXTURE();
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(await openLink(101)).toBeInTheDocument();
  });

  it('draft → Submit (held) over a fresh cached list: the new approval is found (#261 gate)', async () => {
    expenseStatus = 'draft';
    approvals = FIXTURE().filter((a) => a.id !== 101);
    const { client } = await openRecord('/books/expenses/12');
    // Fresh shared cache WITHOUT the approval-to-be.
    client.setQueryData(inboxKeys.approvals, approvals);
    vi.mocked(api.postExpense).mockImplementation(() => {
      expenseStatus = 'pending';
      approvals = FIXTURE();
      return Promise.resolve({
        expense: EXPENSE('pending'),
        policy: {
          action: 'hold-for-approval',
          reason: 'Voucher amount 65000 exceeds ceiling 5000',
        },
      } as never);
    });
    fireEvent.click(
      await screen.findByRole('button', { name: 'Submit for posting' }),
    );
    expect(await openLink(101)).toBeInTheDocument();
  });

  it('approval gone before the click (fresh cached link): re-checked on entry, never shown decidable', async () => {
    await openRecord('/books/expenses/12');
    const link = await openLink(101);
    // Another actor resolves 101; the shared cache is still fresh.
    approvals = FIXTURE().filter((a) => a.id !== 101);
    fireEvent.click(link);
    await expectAt('/inbox/approval/101', 3);
    expect(screen.queryByRole('button', { name: /^Approve/ })).toBeNull();
    expect(await screen.findByText('No pending approval')).toBeInTheDocument();
    expect(
      screen.getByText(/may have been decided or withdrawn/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Approve/ })).toBeNull();
    // Bank match 12 / invoice 12 are not offered as successors.
    expect(screen.queryByRole('button', { name: /Open approval/ })).toBeNull();
    expect(screen.queryByRole('link', { name: /Back to Inbox/ })).toBeNull();
    fireEvent.click(
      screen.getByRole('button', { name: 'Return to Expense #12' }),
    );
    await expectAt('/books/expenses/12', 2);
  });

  it('replaced by a current approval of the SAME typed pair: offered; a cross-object pointer is not', async () => {
    await openRecord('/books/expenses/12');
    const link = await openLink(101);
    // 101 is superseded by a bank match approval (the server does not tie
    // successors to the same object) and a new expense-12 approval exists.
    approvals = [
      ...FIXTURE().filter((a) => a.id !== 101),
      APPROVAL(105, 'reconciliation_match', 12),
      APPROVAL(106, 'expense', 12),
    ];
    fireEvent.click(link);
    expect(await screen.findByText('No pending approval')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Open approval #105' }),
    ).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Open approval #106' }));
    await expectAt('/inbox/approval/106', 3);
    expect(
      await screen.findByText('Single item · returns to Expense #12'),
    ).toBeInTheDocument();
  });

  it('a failed entry re-check keeps the cached approval readable but Approve off', async () => {
    await openRecord('/books/expenses/12');
    const link = await openLink(101);
    approvalsError = new Error('approvals down');
    fireEvent.click(link);
    expect(
      await screen.findByText(/Approve is off until this approval re-checks/),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Approve/ })).toBeDisabled();
    approvalsError = null;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^Approve/ })).toBeEnabled(),
    );
  });

  it('direct link to an unknown approval: no history claimed, existing Inbox fallback', async () => {
    renderApp('/inbox/approval/777');
    expect(await screen.findByText('No pending approval')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Approval #777 is not in the pending list — it may have been decided or withdrawn.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /back to inbox/i }),
    ).toHaveAttribute('href', '/inbox');
  });
});
