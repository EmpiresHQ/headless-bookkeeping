import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
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
        tax_status: null,
      },
    ]);
    vi.mocked(api.getReportingPeriods).mockResolvedValue([]);
    // Default: resolves to a thumbnail blob URL. Individual tests override
    // with a rejection to exercise the fallback glyph.
    vi.mocked(api.fetchDocumentPreviewObjectUrl).mockResolvedValue(
      'blob:thumb',
    );
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
    expect(screen.getByText('−89.00 €')).toBeInTheDocument();
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

  describe('document thumbnails', () => {
    it('renders the document thumbnail on the triage row when the preview fetch resolves', async () => {
      renderAt('/inbox');
      expect(
        await screen.findByText('cheque_scan_038.jpg'),
      ).toBeInTheDocument();

      expect(api.fetchDocumentPreviewObjectUrl).toHaveBeenCalledWith(12);
      // The <img> has alt="" (decorative) so it is excluded from the a11y
      // tree's "img" role — query the DOM directly instead of by role.
      await waitFor(() => {
        const img = document.body.querySelector('img');
        expect(img).not.toBeNull();
        expect(img).toHaveAttribute('src', 'blob:thumb');
      });
    });

    it('falls back to the reason glyph when the preview fetch rejects, and the row still navigates', async () => {
      vi.mocked(api.fetchDocumentPreviewObjectUrl).mockRejectedValue(
        new Error('no preview'),
      );
      renderAt('/inbox');
      const row = await screen.findByText('cheque_scan_038.jpg');
      expect(row).toBeInTheDocument();

      // Fallback glyph renders instead of an <img>.
      await waitFor(() => {
        expect(document.body.querySelector('img')).toBeNull();
      });
      expect(screen.getByText('?')).toBeInTheDocument();

      const link = row.closest('a');
      expect(link).toHaveAttribute('href', '/inbox/doc/12');
    });

    describe('preview lightbox stays out of the row link (UI-002)', () => {
      async function openPreview() {
        const router = renderAt('/inbox');
        const thumb = await screen.findByRole('button', {
          name: 'Open document preview',
        });
        fireEvent.click(thumb);
        const dialog = await screen.findByRole('dialog', {
          name: 'Document preview',
        });
        return { router, thumb, dialog };
      }

      it('renders no interactive element inside any row link', async () => {
        await openPreview();
        const links = screen.getAllByRole('link');
        expect(links.length).toBeGreaterThan(0);
        for (const link of links) {
          expect(
            link.querySelector(
              'a, button, input, select, textarea, [tabindex]',
            ),
          ).toBeNull();
        }
        // Neither the thumb button nor the open dialog sit inside the link.
        const button = screen.getByRole('button', {
          name: 'Open document preview',
        });
        expect(button.closest('a')).toBeNull();
        expect(screen.getByRole('dialog').closest('a')).toBeNull();
      });

      it.each([
        ['the backdrop', (dialog: HTMLElement) => fireEvent.click(dialog)],
        [
          'the X button',
          (dialog: HTMLElement) =>
            fireEvent.click(
              within(dialog).getByRole('button', { name: 'Close preview' }),
            ),
        ],
        ['Escape', () => fireEvent.keyDown(window, { key: 'Escape' })],
      ])(
        'closing via %s only closes the preview and keeps /inbox',
        async (_label, close) => {
          const { router, dialog } = await openPreview();
          // jsdom doesn't run an <a>'s native default action, so an X click
          // bubbling through a real <a> would pass unnoticed here — assert the
          // dialog is outside any link as well as the router outcome.
          expect(dialog.closest('a')).toBeNull();
          close(dialog);

          await waitFor(() =>
            expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
          );
          expect(router.state.location.pathname).toBe('/inbox');
          expect(router.state.historyAction).toBe('POP');
          expect(screen.queryByText('doc detail')).not.toBeInTheDocument();
          // The list (and its row) is still mounted, not re-rendered from a
          // detail round-trip.
          expect(screen.getByText('cheque_scan_038.jpg')).toBeInTheDocument();
        },
      );

      it('opening the preview does not navigate', async () => {
        const { router } = await openPreview();
        expect(router.state.location.pathname).toBe('/inbox');
      });

      it('clicking the row itself still navigates to the document', async () => {
        const router = renderAt('/inbox');
        await screen.findByRole('button', { name: 'Open document preview' });
        fireEvent.click(screen.getByText('cheque_scan_038.jpg'));
        expect(await screen.findByText('doc detail')).toBeInTheDocument();
        expect(router.state.location.pathname).toBe('/inbox/doc/12');
      });
    });

    it('does not fetch a thumbnail for an approval row (no document id) and shows the checkmark glyph', async () => {
      renderAt('/inbox');
      expect(await screen.findByText('Telia Eesti AS')).toBeInTheDocument();

      // The approval's object_id (214) must never be used as a document id.
      expect(api.fetchDocumentPreviewObjectUrl).not.toHaveBeenCalledWith(214);
      expect(screen.getByText('✓')).toBeInTheDocument();
    });
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

  it('useSeg round-trip: ?tab= alias reads, switching segments writes ?seg= and drops ?tab= (P06 Task 3)', async () => {
    const router = renderAt('/inbox?tab=approvals');
    expect(
      await screen.findByRole('tab', { name: 'Approvals 1' }),
    ).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(screen.getByRole('tab', { name: 'Triage 1' }));
    const search = new URLSearchParams(router.state.location.search);
    expect(search.get('seg')).toBe('triage');
    expect(search.get('tab')).toBeNull();
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
    // Scoped to the hero card — the U+2212 minus glyph decision (Plan 06
    // Task 2) makes this amount string identical to the queue row's amount,
    // so an unscoped getByText would now match both.
    const hero = screen.getByText('expenses this period').closest('div');
    expect(hero).not.toBeNull();
    expect(
      within(hero as HTMLElement).getByText('−89.00 €'),
    ).toBeInTheDocument();
    const cta = screen.getByRole('link', { name: /Start clearing · 2/ });
    // The first row AS RENDERED (Earlier before Today) — the same member the
    // run starts with (issue #253), not the newest entry.
    expect(cta).toHaveAttribute('href', '/inbox/approval/7');
  });

  describe('queue run (issue #253)', () => {
    const runOf = (router: ReturnType<typeof renderAt>) =>
      (router.state.location.state as { hbkRun?: unknown } | null)?.hbkRun;

    it('Start clearing snapshots the rendered order, Earlier then Today', async () => {
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
      const router = renderAt('/inbox');
      fireEvent.click(
        await screen.findByRole('link', { name: /Start clearing · 2/ }),
      );
      await waitFor(() =>
        expect(router.state.location.pathname).toBe('/inbox/approval/7'),
      );
      expect(runOf(router)).toEqual({
        seg: 'all',
        members: ['/inbox/approval/7', '/inbox/doc/12'],
      });
    });

    it('a non-first row starts a run over the whole visible segment, clicked item included', async () => {
      const router = renderAt('/inbox');
      await openRowByText(router, 'cheque_scan_038.jpg', '/inbox/doc/12');
      expect(runOf(router)).toEqual({
        seg: 'all',
        members: ['/inbox/approval/7', '/inbox/doc/12'],
      });
    });

    it("a segment run holds only that segment's items", async () => {
      const router = renderAt('/inbox?seg=triage');
      await openRowByText(router, 'cheque_scan_038.jpg', '/inbox/doc/12');
      expect(runOf(router)).toEqual({
        seg: 'triage',
        members: ['/inbox/doc/12'],
      });
    });
  });

  it('hides the hero when no period is open', async () => {
    renderAt('/inbox'); // getReportingPeriods resolves [] in the shared fixture
    await screen.findByText('Telia Eesti AS');
    expect(screen.queryByText(/expenses this period/)).not.toBeInTheDocument();
  });

  it('uploads through the shared sheet: same payer field, claimant sent, a needs-review result opens as a SINGLE item returning to this segment (#258)', async () => {
    vi.mocked(api.getEntities).mockResolvedValue([
      {
        id: 3,
        role: 'supplier',
        country: 'EE',
        name: 'Telia Eesti AS',
        goods_vs_services: null,
        tax_status: null,
      },
      {
        id: 5,
        role: 'employee',
        country: 'EE',
        name: 'Mari Maasikas',
        goods_vs_services: null,
        tax_status: null,
      },
    ]);
    vi.mocked(api.uploadDocument).mockResolvedValue({
      document: {
        id: 99,
        filename: 'r.pdf',
        mime_type: 'application/pdf',
        size_bytes: 1,
        status: 'pending',
        processing_since: null,
        created_at: 1,
        claimant_id: 5,
      },
      deduplicated: false,
    });
    vi.mocked(api.triageDocument).mockImplementation(async () => {
      // The workflow parked it: the queue now holds it.
      vi.mocked(api.getNeedsTriageItems).mockResolvedValue([
        {
          id: 99,
          filename: 'r.pdf',
          created_at: NOW,
          reason: 'Unknown supplier',
          reason_type: 'supplier_unresolved',
        },
      ]);
      return { kind: 'unknown', document_id: 99, reason: 'Unknown supplier' };
    });
    const router = renderAt('/inbox?seg=triage');
    await screen.findByText('cheque_scan_038.jpg');
    fireEvent.click(screen.getByRole('button', { name: 'Upload' }));
    const payer = await screen.findByLabelText('Paid by (claimant)');
    // Suppliers are never offered as the payer.
    expect(
      within(payer).queryByRole('option', { name: 'Telia Eesti AS' }),
    ).toBeNull();
    fireEvent.change(payer, { target: { value: '5' } });
    const file = new File(['x'], 'r.pdf', { type: 'application/pdf' });
    fireEvent.change(screen.getByLabelText('File'), {
      target: { files: [file] },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Upload & process' }));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/inbox/doc/99'),
    );
    expect(api.uploadDocument).toHaveBeenCalledWith(file, { claimantId: 5 });
    expect(api.triageDocument).toHaveBeenCalledTimes(1);
    const state = router.state.location.state as Record<string, unknown>;
    // Single item: no queue run; its origin is this Inbox segment.
    expect(state.hbkRun).toBeUndefined();
    expect((state.hbkOrigin as { href: string }).href).toBe(
      '/inbox?seg=triage',
    );
  });
});
