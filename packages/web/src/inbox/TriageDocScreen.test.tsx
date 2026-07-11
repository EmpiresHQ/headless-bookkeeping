import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  getNeedsTriageItems: vi.fn(),
  getPendingApprovals: vi.fn(),
  getDocumentDetails: vi.fn(),
  getDocumentReclassify: vi.fn(),
  getPendingDraft: vi.fn(),
  getCategories: vi.fn(),
  getEntities: vi.fn(),
  getExpenses: vi.fn(),
  completeDocument: vi.fn(),
  retryDocument: vi.fn(),
  deleteDocument: vi.fn(),
  manualClassify: vi.fn(),
  fetchDocumentPreviewObjectUrl: vi.fn(),
  openSignedDocument: vi.fn(),
}));

vi.mock('../queries/inbox', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../queries/inbox')>()),
  invalidateInbox: vi.fn(),
}));

import * as api from '../api';
import type { Entity, NeedsTriageItem } from '../api';
import { invalidateInbox } from '../queries/inbox';
import { TriageDocScreen } from './TriageDocScreen';

const ITEM = (over: Partial<NeedsTriageItem> = {}): NeedsTriageItem => ({
  id: 12,
  filename: 'cheque_scan_038.jpg',
  created_at: 100,
  reason: 'AI confidence 0.41 below threshold 0.8',
  reason_type: 'low_confidence',
  ...over,
});

const SUPPLIER: Entity = {
  id: 3,
  role: 'supplier',
  country: 'EE',
  name: 'Circle K Eesti AS',
  goods_vs_services: null,
};

/** Reclassify payload keyed by document id — lets one mockImplementation
 *  serve BOTH docs so the remount pin can tell 12's prefill from 13's. */
const RECLASSIFY = (id: number, grossAmount: number, vatAmount: number) => ({
  document_id: id,
  ocr: { ok: true as const, markdown: 'x' },
  classification: {
    ok: true as const,
    result: {
      kind: 'new_expense',
      document_type: 'receipt',
      gross_amount: grossAmount,
      vat_amount: vatAmount,
      currency: 'EUR',
      tax_point_date: '2026-07-01',
      category: 'fuel',
      document_vat_marking: null,
      supplier_invoice_number: null,
      confidence: 0.41,
    },
  },
});

/** Opens the classify sheet, waits for its prefill, picks the supplier and
 *  submits — the shared choreography of the two remount-discipline tests. */
async function openClassifyPickSupplierAndSubmit(grossDisplay: string) {
  fireEvent.click(await screen.findByRole('button', { name: 'Classify…' }));
  expect(await screen.findByDisplayValue(grossDisplay)).toBeInTheDocument();
  fireEvent.change(screen.getByPlaceholderText(/search suppliers/i), {
    target: { value: 'circle' },
  });
  fireEvent.click(screen.getByRole('button', { name: /Circle K Eesti AS/ }));
  const submit = screen.getByRole('button', {
    name: `Create expense · −${grossDisplay} €`,
  });
  await waitFor(() => expect(submit).toBeEnabled());
  fireEvent.click(submit);
  // Wait for finishTriage's full synchronous body (through its trailing
  // await invalidateInbox) to have run — both outcome branches call it last,
  // so this is the settling point for setSheet/toastOk-or-Err/navigate
  // that would otherwise land outside act() between this helper returning
  // and the caller's next await.
  await waitFor(() => expect(invalidateInbox).toHaveBeenCalled());
}

function renderAt(path: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const router = createMemoryRouter(
    [
      { path: '/inbox', element: <p>queue</p> },
      { path: '/inbox/doc/:id', element: <TriageDocScreen /> },
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

describe('TriageDocScreen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getNeedsTriageItems).mockResolvedValue([
      ITEM(),
      ITEM({ id: 13, filename: 'later.pdf', created_at: 200 }),
    ]);
    vi.mocked(api.getPendingApprovals).mockResolvedValue([]);
    vi.mocked(api.getDocumentDetails).mockResolvedValue({
      document_id: 12,
      ocr: { ok: true, markdown: 'CIRCLE K 48.20 …' },
      classification: {
        ok: true,
        result: {
          kind: 'new_expense',
          document_type: 'receipt',
          gross_amount: 4820,
          vat_amount: 867,
          currency: 'EUR',
          tax_point_date: '2026-07-01',
          category: 'fuel',
          document_vat_marking: null,
          supplier_invoice_number: null,
          confidence: 0.41,
        },
      },
    });
    vi.mocked(api.getCategories).mockResolvedValue([]);
    vi.mocked(api.getEntities).mockResolvedValue([]);
    vi.mocked(api.getExpenses).mockResolvedValue([]);
    vi.mocked(api.fetchDocumentPreviewObjectUrl).mockRejectedValue(
      new Error('no preview'),
    );
  });

  it('renders N of M, the human reason with the raw sentence, and persisted facts', async () => {
    renderAt('/inbox/doc/12');
    expect(await screen.findByText('1 of 2')).toBeInTheDocument();
    expect(
      screen.getByText(
        'AI confidence 0.41 — below the 0.8 threshold, check the result',
      ),
    ).toBeInTheDocument();
    expect(await screen.findByText('−48.20 €')).toBeInTheDocument();
    expect(screen.getByText('01.07.2026')).toBeInTheDocument();
    expect(screen.getByText('OCR text')).toBeInTheDocument();
  });

  it('routes low_confidence to the classify sheet as the single primary', async () => {
    vi.mocked(api.getDocumentReclassify).mockResolvedValue({
      document_id: 12,
      ocr: { ok: true, markdown: 'x' },
      classification: null,
    });
    renderAt('/inbox/doc/12');
    fireEvent.click(await screen.findByRole('button', { name: 'Classify…' }));
    expect(
      await screen.findByText('Classify', { selector: 'h2' }),
    ).toBeInTheDocument();
  });

  it('routes supplier_unresolved to the resolve sheet', async () => {
    vi.mocked(api.getNeedsTriageItems).mockResolvedValue([
      ITEM({
        reason_type: 'supplier_unresolved',
        reason: 'supplier not found',
      }),
    ]);
    vi.mocked(api.getPendingDraft).mockResolvedValue({
      document_id: 12,
      reason: 'supplier not found',
      supplier_proposal: {
        create_name: 'X',
        create_country: 'EE',
        create_registration_key: 'Y',
      },
      draft: {
        category: 'fuel',
        gross_amount: 1,
        vat_amount: 0,
        currency: 'EUR',
        tax_point_date: '2026-07-01',
        supplier_invoice_number: null,
      },
    });
    renderAt('/inbox/doc/12');
    fireEvent.click(
      await screen.findByRole('button', { name: 'Resolve supplier…' }),
    );
    expect(
      await screen.findByText('Resolve supplier', { selector: 'h2' }),
    ).toBeInTheDocument();
  });

  it('dismisses behind a ConfirmDialog and advances to the next item', async () => {
    vi.mocked(api.completeDocument).mockResolvedValue({
      id: 12,
      status: 'processed',
    });
    const router = renderAt('/inbox/doc/12');
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss' }));
    fireEvent.click(
      await screen.findByRole('button', { name: 'Dismiss document' }),
    );
    await waitFor(() => expect(api.completeDocument).toHaveBeenCalledWith(12));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/inbox/doc/13'),
    );
  });

  it('Retry AI re-queues the document and advances', async () => {
    vi.mocked(api.retryDocument).mockResolvedValue({ ok: true });
    const router = renderAt('/inbox/doc/12');
    fireEvent.click(await screen.findByRole('button', { name: 'Retry AI' }));
    await waitFor(() => expect(api.retryDocument).toHaveBeenCalledWith(12));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/inbox/doc/13'),
    );
  });

  it('not_a_document gets Dismiss as primary plus a destructive Delete', async () => {
    vi.mocked(api.getNeedsTriageItems).mockResolvedValue([
      ITEM({
        reason_type: 'not_a_document',
        reason: 'Not a business accounting document — …',
      }),
    ]);
    vi.mocked(api.deleteDocument).mockResolvedValue({ deleted: 12 });
    const router = renderAt('/inbox/doc/12');
    expect(
      await screen.findByRole('button', { name: 'Delete file…' }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete file…' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(api.deleteDocument).toHaveBeenCalledWith(12));
    await waitFor(() => expect(router.state.location.pathname).toBe('/inbox'));
  });

  it('shows the already-handled state for an id not in the queue', async () => {
    renderAt('/inbox/doc/404');
    expect(await screen.findByText('Already handled')).toBeInTheDocument();
  });

  it('offers no Delete for reasons other than not_a_document', async () => {
    renderAt('/inbox/doc/12'); // low_confidence
    await screen.findByText('1 of 2');
    expect(
      screen.queryByRole('button', { name: 'Delete file…' }),
    ).not.toBeInTheDocument();
  });

  it('re-enables actions and closes the dialog after dismiss advances', async () => {
    // Auto-advance re-renders the SAME TriageDocScreen element (param-only
    // change) — screen-level busy/confirm must not brick the next document.
    vi.mocked(api.completeDocument).mockResolvedValue({
      id: 12,
      status: 'processed',
    });
    const router = renderAt('/inbox/doc/12');
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss' }));
    fireEvent.click(
      await screen.findByRole('button', { name: 'Dismiss document' }),
    );
    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/inbox/doc/13'),
    );
    expect(await screen.findByText('later.pdf')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry AI' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Classify…' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeEnabled();
    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: 'Dismiss document' }),
      ).not.toBeInTheDocument(),
    );
  });

  it('remounts the classify sheet per document — fresh fields and a live submit after advancing', async () => {
    vi.mocked(api.getEntities).mockResolvedValue([SUPPLIER]);
    vi.mocked(api.getDocumentReclassify).mockImplementation((id) =>
      id === 12
        ? Promise.resolve(RECLASSIFY(12, 4820, 867))
        : Promise.resolve(RECLASSIFY(id, 9900, 1785)),
    );
    vi.mocked(api.manualClassify).mockResolvedValue({
      kind: 'expense',
      document_id: 12,
      expense_id: 700,
    });
    const router = renderAt('/inbox/doc/12');
    await openClassifyPickSupplierAndSubmit('48.20');
    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/inbox/doc/13'),
    );
    // Reopen on doc 13: MUST be a fresh sheet instance — 13's prefill, no
    // stale 12 fields, and a submit button that is not stuck busy ('…').
    fireEvent.click(await screen.findByRole('button', { name: 'Classify…' }));
    expect(await screen.findByDisplayValue('99.00')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('48.20')).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Create expense · −99.00 €' }),
    ).toBeInTheDocument();
  });

  it('closes a carried-over sheet before advancing — OcrFailedSheet Retry OCR must not reopen Fix-file over the next document', async () => {
    // Regression for the sheet-carry-over hazard: runAction used to reset
    // busy/confirm but not `sheet`, so OcrFailedSheet's onRetried -> runAction
    // -> navigate path re-rendered this element for doc 13 with sheet==='ocr'
    // still set — a fresh Fix-file sheet auto-opened over the WRONG document.
    vi.mocked(api.getNeedsTriageItems).mockResolvedValue([
      ITEM({
        reason_type: 'ocr_failed',
        reason: 'OCR could not read the file',
      }),
      ITEM({
        id: 13,
        filename: 'later.pdf',
        created_at: 200,
        reason_type: 'ocr_failed',
        reason: 'OCR could not read the file',
      }),
    ]);
    vi.mocked(api.retryDocument).mockResolvedValue({ ok: true });
    const router = renderAt('/inbox/doc/12');
    fireEvent.click(await screen.findByRole('button', { name: 'Fix file…' }));
    expect(
      await screen.findByText('Fix file', { selector: 'h2' }),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', { name: 'Retry OCR on this file' }),
    );
    await waitFor(() => expect(api.retryDocument).toHaveBeenCalledWith(12));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/inbox/doc/13'),
    );
    await screen.findByText('later.pdf');
    expect(
      screen.queryByText('Fix file', { selector: 'h2' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Retry OCR on this file' }),
    ).not.toBeInTheDocument();
  });

  it('navigates to the next document WHILE the inbox invalidation is still pending (no "Already handled" flash)', async () => {
    vi.mocked(api.completeDocument).mockResolvedValue({
      id: 12,
      status: 'processed',
    });
    let release!: () => void;
    vi.mocked(invalidateInbox).mockReturnValue(
      new Promise<void>((r) => (release = r)),
    );
    try {
      const router = renderAt('/inbox/doc/12');
      fireEvent.click(await screen.findByRole('button', { name: 'Dismiss' }));
      fireEvent.click(
        await screen.findByRole('button', { name: 'Dismiss document' }),
      );
      await waitFor(() =>
        expect(router.state.location.pathname).not.toBe('/inbox/doc/12'),
      );
      expect(router.state.location.pathname).toBe('/inbox/doc/13');
    } finally {
      // Always release, even if an assertion above throws — otherwise the
      // never-resolved invalidateInbox promise leaks into later tests.
      release();
    }
  });

  it('unknown outcome stays on the document and reopening gets a fresh, non-busy sheet', async () => {
    vi.mocked(api.getEntities).mockResolvedValue([SUPPLIER]);
    vi.mocked(api.getDocumentReclassify).mockResolvedValue(
      RECLASSIFY(12, 4820, 867),
    );
    vi.mocked(api.manualClassify).mockResolvedValue({
      kind: 'unknown',
      document_id: 12,
      reason: 'could not book',
    });
    const router = renderAt('/inbox/doc/12');
    await openClassifyPickSupplierAndSubmit('48.20');
    // Still unresolved: the operator stays here.
    expect(router.state.location.pathname).toBe('/inbox/doc/12');
    // Reopen to retry — same doc, so only a key nonce can remount the sheet
    // whose success path deliberately left busy=true.
    fireEvent.click(await screen.findByRole('button', { name: 'Classify…' }));
    expect(await screen.findByDisplayValue('48.20')).toBeInTheDocument();
    expect(
      await screen.findByRole('button', {
        name: 'Create expense · −48.20 €',
      }),
    ).toBeInTheDocument();
  });
});
