import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  getNeedsTriageItems: vi.fn(),
  getPendingApprovals: vi.fn(),
  getExpenses: vi.fn(),
  getInvoices: vi.fn(),
  getEntities: vi.fn(),
  getReportingPeriods: vi.fn(),
  uploadDocument: vi.fn(),
  triageDocument: vi.fn(),
  fetchDocumentPreviewObjectUrl: vi.fn(),
}));

import * as api from '../api';
import { InboxScreen } from './InboxScreen';
import { UnsavedChangesProvider } from '../lib/unsavedChanges';

// Fixed clock (not the real wall clock — see beforeEach/afterEach below):
// picking Date.now() at import time made the Today/Earlier split flaky
// within an hour of local midnight, since `NOW - 3600` (nominally "today")
// would roll into "Earlier" once the wall clock crossed midnight.
const FIXED_NOW = new Date('2026-07-09T12:00:00');
const NOW = Math.floor(FIXED_NOW.getTime() / 1000);
const YESTERDAY = NOW - 86400 * 2;

function renderAt(
  path: string,
  client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  }),
) {
  const router = createMemoryRouter(
    [
      { path: '/inbox', element: <InboxScreen /> },
      { path: '/inbox/doc/:id', element: <p>doc detail</p> },
      { path: '/inbox/approval/:id', element: <p>approval detail</p> },
    ],
    { initialEntries: [path] },
  );
  render(
    <QueryClientProvider client={client}>
      <UnsavedChangesProvider onUnauthorized={() => undefined}>
        <RouterProvider router={router} />
      </UnsavedChangesProvider>
    </QueryClientProvider>,
  );
  return router;
}

async function openRowByText(
  router: ReturnType<typeof renderAt>,
  text: string,
  path: string,
) {
  fireEvent.click(await screen.findByText(text));
  await waitFor(() => expect(router.state.location.pathname).toBe(path));
}

const OPEN_PERIOD = [
  {
    id: 1,
    name: 'July 2026',
    start_date: '2026-07-01',
    end_date: '2026-07-31',
    status: 'open',
    filed_at: null,
  },
];

const BANK_MATCH = {
  id: 8,
  object_type: 'reconciliation_match',
  object_id: 41,
  status: 'pending',
  requested_by: 'system:policy',
  approved_by: null,
  rejected_reason: null,
  policy_reason: null,
  superseded_by: null,
  created_at: YESTERDAY + 60,
  resolved_at: null,
};

const searchBox = () =>
  screen.getByRole('searchbox', { name: 'Search the Inbox' });
const stateOf = (router: ReturnType<typeof renderAt>) =>
  router.state.location.state as Record<string, unknown> | null;

describe('InboxScreen search (issue #278)', () => {
  beforeEach(() => {
    vi.setSystemTime(FIXED_NOW);
    vi.clearAllMocks();
    vi.mocked(api.getNeedsTriageItems).mockResolvedValue([
      {
        id: 12,
        filename: 'cheque_scan_038.jpg',
        created_at: NOW - 3600,
        reason: 'AI confidence 0.41 below threshold 0.8',
        reason_type: 'low_confidence',
      },
    ]);
    vi.mocked(api.getPendingApprovals).mockResolvedValue([
      {
        id: 7,
        object_type: 'expense',
        object_id: 214,
        status: 'pending',
        requested_by: 'system:policy',
        approved_by: null,
        rejected_reason: null,
        policy_reason: 'Voucher amount 8900 exceeds ceiling 5000',
        superseded_by: null,
        created_at: YESTERDAY,
        resolved_at: null,
      },
    ]);
    vi.mocked(api.getExpenses).mockResolvedValue([
      {
        id: 214,
        supplier_id: 3,
        category: 'software',
        gross_amount: 8900,
        vat_amount: 1632,
        currency: 'EUR',
        tax_point_date: '2026-07-03',
        supplier_invoice_number: 'TL-2026/07',
        status: 'pending',
        reconciled: false,
      },
    ]);
    vi.mocked(api.getInvoices).mockResolvedValue([]);
    vi.mocked(api.getEntities).mockResolvedValue([
      {
        id: 3,
        role: 'supplier',
        country: 'EE',
        name: 'Telia Eesti AS',
        goods_vs_services: null,
        tax_status: null,
      },
    ]);
    vi.mocked(api.getReportingPeriods).mockResolvedValue([]);
    vi.mocked(api.fetchDocumentPreviewObjectUrl).mockResolvedValue(
      'blob:thumb',
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('narrows the rows by name, number, amount and date; counts stay unfiltered', async () => {
    renderAt('/inbox?q=telia');
    expect(await screen.findByText('Telia Eesti AS')).toBeInTheDocument();
    await screen.findByText(/Showing 1 of 2 tasks/);
    expect(screen.queryByText('cheque_scan_038.jpg')).toBeNull();
    expect(searchBox()).toHaveValue('telia');
    // The queue itself is unchanged: header and segment counts.
    expect(screen.getByText('2 tasks')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Triage 1' })).toBeInTheDocument();
    expect(
      screen.getByRole('radio', { name: 'Approvals 1' }),
    ).toBeInTheDocument();

    fireEvent.change(searchBox(), { target: { value: 'tl-2026/07' } });
    expect(await screen.findByText('Telia Eesti AS')).toBeInTheDocument();
    fireEvent.change(searchBox(), { target: { value: '89,00' } });
    expect(await screen.findByText('Telia Eesti AS')).toBeInTheDocument();
    expect(screen.queryByText('cheque_scan_038.jpg')).toBeNull();
    // Arrival date of the triage document (today, 9 Jul).
    fireEvent.change(searchBox(), { target: { value: '9 jul' } });
    expect(await screen.findByText('cheque_scan_038.jpg')).toBeInTheDocument();
    expect(screen.queryByText('Telia Eesti AS')).toBeNull();
  });

  it('a search hit opens as a SINGLE item recording the searched list as its origin', async () => {
    const router = renderAt('/inbox?seg=approvals&q=telia');
    await openRowByText(router, 'Telia Eesti AS', '/inbox/approval/7');
    const state = stateOf(router) as Record<string, unknown>;
    expect(state.hbkRun).toBeUndefined();
    expect((state.hbkOrigin as { href: string }).href).toBe(
      '/inbox?seg=approvals&q=telia',
    );
  });

  it('Start clearing keeps the whole unfiltered queue as its run and says so', async () => {
    vi.mocked(api.getReportingPeriods).mockResolvedValue(OPEN_PERIOD as never);
    const router = renderAt('/inbox?q=cheque');
    await screen.findByText('cheque_scan_038.jpg');
    expect(
      await screen.findByText('Whole Inbox queue — ignores the search'),
    ).toBeInTheDocument();
    const cta = screen.getByRole('link', { name: /Start clearing · 2/ });
    // First member of the UNFILTERED order, not the first search hit.
    expect(cta).toHaveAttribute('href', '/inbox/approval/7');
    fireEvent.click(cta);
    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/inbox/approval/7'),
    );
    expect(stateOf(router)?.hbkRun).toEqual({
      seg: 'all',
      members: ['/inbox/approval/7', '/inbox/doc/12'],
    });
  });

  it('without a search, rows still start a queue run (unchanged)', async () => {
    const router = renderAt('/inbox');
    await openRowByText(router, 'cheque_scan_038.jpg', '/inbox/doc/12');
    expect(stateOf(router)?.hbkRun).toEqual({
      seg: 'all',
      members: ['/inbox/approval/7', '/inbox/doc/12'],
    });
    expect(screen.queryByText(/ignores the search/)).toBeNull();
  });

  it('no hits on a non-empty queue is "No tasks match", never Inbox zero; Clear keeps seg and state', async () => {
    const router = renderAt('/inbox?seg=triage&q=zzz&keep=1');
    const origin = {
      hbkOrigin: { href: '/books', state: null, idx: 0, key: 'k' },
    };
    await act(() =>
      router.navigate('/inbox?seg=triage&q=zzz&keep=1', {
        replace: true,
        state: origin,
      }),
    );
    expect(await screen.findByText('No tasks match')).toBeInTheDocument();
    expect(screen.queryByText('Inbox zero')).toBeNull();
    // The summary's Clear and the empty state's Clear do the same.
    const clears = screen.getAllByRole('button', { name: 'Clear search' });
    expect(clears).toHaveLength(2);
    fireEvent.click(clears[1]);
    expect(await screen.findByText('cheque_scan_038.jpg')).toBeInTheDocument();
    const params = new URLSearchParams(router.state.location.search);
    expect(params.get('q')).toBeNull();
    expect(params.get('seg')).toBe('triage');
    expect(params.get('keep')).toBe('1');
    expect(router.state.historyAction).toBe('REPLACE');
    expect(stateOf(router)).toEqual(origin);
    await waitFor(() => expect(searchBox()).toHaveFocus());
  });

  it('an empty queue is still Inbox zero while searching', async () => {
    vi.mocked(api.getNeedsTriageItems).mockResolvedValue([]);
    vi.mocked(api.getPendingApprovals).mockResolvedValue([]);
    renderAt('/inbox?q=anything');
    expect(await screen.findByText('Inbox zero')).toBeInTheDocument();
    expect(screen.queryByText('No tasks match')).toBeNull();
  });

  it('the search survives a segment switch', async () => {
    const router = renderAt('/inbox?q=telia');
    await screen.findByText('Telia Eesti AS');
    fireEvent.click(screen.getByRole('radio', { name: 'Triage 1' }));
    await waitFor(() =>
      expect(new URLSearchParams(router.state.location.search).get('seg')).toBe(
        'triage',
      ),
    );
    expect(new URLSearchParams(router.state.location.search).get('q')).toBe(
      'telia',
    );
    expect(await screen.findByText('No tasks match')).toBeInTheDocument();
    expect(searchBox()).toHaveValue('telia');
  });

  it('bank-match approvals: the title/date-only limit is stated while searching', async () => {
    vi.mocked(api.getPendingApprovals).mockResolvedValue([BANK_MATCH] as never);
    renderAt('/inbox?seg=approvals&q=89');
    expect(
      await screen.findByText(
        /1 approval \(bank match or other\) is searched by title and arrival date only/,
      ),
    ).toBeInTheDocument();
    expect(await screen.findByText('No tasks match')).toBeInTheDocument();
  });

  it('approval facts still loading: says approvals cannot match by name yet', async () => {
    vi.mocked(api.getExpenses).mockReturnValue(new Promise(() => undefined));
    renderAt('/inbox?q=telia');
    expect(
      await screen.findByText(/Approval names and amounts are still loading/),
    ).toBeInTheDocument();
    expect(await screen.findByText('No tasks match')).toBeInTheDocument();
  });

  it('facts loaded once but their refresh failed: the search says it uses the last loaded ones', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    // Cached from an earlier visit; the mount refetch fails and keeps it.
    client.setQueryData(['expenses'], await api.getExpenses());
    vi.mocked(api.getExpenses).mockRejectedValue(new Error('expenses down'));
    renderAt('/inbox?q=telia', client);
    expect(await screen.findByText('Telia Eesti AS')).toBeInTheDocument();
    expect(
      await screen.findByText(
        /Approval names and amounts failed to refresh — the search uses the last loaded ones/,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/still loading|failed to load/)).toBeNull();
  });

  it('a failed list: no result counts, and the no-match claim covers only what loaded', async () => {
    vi.mocked(api.getPendingApprovals).mockRejectedValue(
      new Error('approvals down'),
    );
    renderAt('/inbox?q=zzz');
    expect(await screen.findByText('approvals down')).toBeInTheDocument();
    expect(await screen.findByText('No tasks match')).toBeInTheDocument();
    expect(
      screen.getByText(/Searched only the tasks that loaded/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Showing \d+ of/)).toBeNull();
    expect(screen.getByText('Filtered by')).toBeInTheDocument();
    expect(screen.queryByText('Inbox zero')).toBeNull();
  });
});
