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
  fetchDocumentPreviewObjectUrl: vi.fn(),
  openSignedDocument: vi.fn(),
}));

import * as api from '../api';
import type { NeedsTriageItem } from '../api';
import { TriageDocScreen } from './TriageDocScreen';

const ITEM = (over: Partial<NeedsTriageItem> = {}): NeedsTriageItem => ({
  id: 12,
  filename: 'cheque_scan_038.jpg',
  created_at: 100,
  reason: 'AI confidence 0.41 below threshold 0.8',
  reason_type: 'low_confidence',
  ...over,
});

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
    expect(await screen.findByText('-48.20 €')).toBeInTheDocument();
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
});
