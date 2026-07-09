import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
}));

import * as api from '../api';
import { InboxScreen } from './InboxScreen';

// Fixed clock (not the real wall clock — see beforeEach/afterEach below):
// picking Date.now() at import time made the Today/Earlier split flaky
// within an hour of local midnight, since `NOW - 3600` (nominally "today")
// would roll into "Earlier" once the wall clock crossed midnight.
const FIXED_NOW = new Date('2026-07-09T12:00:00');
const NOW = Math.floor(FIXED_NOW.getTime() / 1000);
const YESTERDAY = NOW - 86400 * 2;

function renderAt(path: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
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
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

describe('InboxScreen', () => {
  beforeEach(() => {
    // Not vi.useFakeTimers(): setSystemTime alone only mocks Date/new Date()
    // (per Vitest's own doc comment on the API), leaving RTL's findBy*/
    // waitFor timers real so nothing here needs manual timer advancement.
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
        supplier_invoice_number: null,
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
      },
    ]);
    vi.mocked(api.getReportingPeriods).mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('merges both sources FIFO with Today/Earlier sections', async () => {
    renderAt('/inbox');
    expect(await screen.findByText(/Earlier/)).toBeInTheDocument();
    expect(screen.getByText(/Today/)).toBeInTheDocument();
    const links = screen.getAllByRole('link');
    // Oldest (the approval, 2 days ago) renders before the fresh triage doc.
    const approvalIdx = links.findIndex(
      (l) => l.getAttribute('href') === '/inbox/approval/7',
    );
    const triageIdx = links.findIndex(
      (l) => l.getAttribute('href') === '/inbox/doc/12',
    );
    expect(approvalIdx).toBeGreaterThanOrEqual(0);
    expect(triageIdx).toBeGreaterThan(approvalIdx);
  });

  it('renders the approval row as counterparty · human reason with numbers · amount', async () => {
    renderAt('/inbox');
    expect(await screen.findByText('Telia Eesti AS')).toBeInTheDocument();
    expect(
      screen.getByText('89.00 € above the 50.00 € auto-post limit'),
    ).toBeInTheDocument();
    expect(screen.getByText('-89.00 €')).toBeInTheDocument();
    expect(screen.getByText('approve?')).toBeInTheDocument();
  });

  it('renders the triage row as filename · human reason with the confidence number', async () => {
    renderAt('/inbox');
    expect(await screen.findByText('cheque_scan_038.jpg')).toBeInTheDocument();
    expect(
      screen.getByText(
        'AI confidence 0.41 — below the 0.8 threshold, check the result',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('classify')).toBeInTheDocument();
  });

  it('filters by segment from ?seg=', async () => {
    renderAt('/inbox?seg=triage');
    expect(await screen.findByText('cheque_scan_038.jpg')).toBeInTheDocument();
    expect(screen.queryByText('Telia Eesti AS')).not.toBeInTheDocument();
  });

  it('accepts the legacy ?tab= param as a segment alias', async () => {
    renderAt('/inbox?tab=approvals');
    expect(await screen.findByText('Telia Eesti AS')).toBeInTheDocument();
    expect(screen.queryByText('cheque_scan_038.jpg')).not.toBeInTheDocument();
  });

  it('shows segment counts in the control', async () => {
    renderAt('/inbox');
    expect(
      await screen.findByRole('tab', { name: 'Triage 1' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('tab', { name: 'Approvals 1' }),
    ).toBeInTheDocument();
  });

  it('shows the inbox-zero state when both queues are empty', async () => {
    vi.mocked(api.getNeedsTriageItems).mockResolvedValue([]);
    vi.mocked(api.getPendingApprovals).mockResolvedValue([]);
    renderAt('/inbox');
    expect(await screen.findByText('Inbox zero')).toBeInTheDocument();
  });

  it('redirects the legacy ?expand=N deep link to the triage detail route', async () => {
    const router = renderAt('/inbox?seg=triage&expand=12');
    expect(await screen.findByText('doc detail')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/inbox/doc/12');
  });

  it('renders the hero card with the open period, month total and CTA to the first item', async () => {
    vi.mocked(api.getReportingPeriods).mockResolvedValue([
      {
        id: 1,
        name: 'July 2026',
        start_date: '2026-07-01',
        end_date: '2026-07-31',
        status: 'open',
        filed_at: null,
      },
    ]);
    renderAt('/inbox');
    expect(await screen.findByText(/July 2026/)).toBeInTheDocument();
    // 89.00 pending expense inside the period (from the shared fixture).
    expect(screen.getByText('−89.00 €')).toBeInTheDocument();
    const cta = screen.getByRole('link', { name: /Start clearing · 2/ });
    // FIFO first = the 2-day-old approval.
    expect(cta).toHaveAttribute('href', '/inbox/approval/7');
  });

  it('hides the hero when no period is open', async () => {
    renderAt('/inbox'); // getReportingPeriods resolves [] in the shared fixture
    await screen.findByText('Telia Eesti AS');
    expect(screen.queryByText(/expenses this period/)).not.toBeInTheDocument();
  });

  it('uploads a file, auto-triages it and refreshes the queue', async () => {
    vi.mocked(api.uploadDocument).mockResolvedValue({
      document: {
        id: 99,
        filename: 'r.pdf',
        mime_type: 'application/pdf',
        size_bytes: 1,
        status: 'pending',
        processing_since: null,
        created_at: 1,
      },
      deduplicated: false,
    });
    vi.mocked(api.triageDocument).mockResolvedValue({
      kind: 'expense',
      document_id: 99,
      expense_id: 500,
    });
    renderAt('/inbox');
    await screen.findByText('Telia Eesti AS');
    const callsBefore = vi.mocked(api.getNeedsTriageItems).mock.calls.length;
    const input = screen.getByLabelText('Upload document');
    fireEvent.change(input, {
      target: {
        files: [new File(['x'], 'r.pdf', { type: 'application/pdf' })],
      },
    });
    await waitFor(() => expect(api.triageDocument).toHaveBeenCalledWith(99));
    await waitFor(() =>
      expect(
        vi.mocked(api.getNeedsTriageItems).mock.calls.length,
      ).toBeGreaterThan(callsBefore),
    );
  });
});
