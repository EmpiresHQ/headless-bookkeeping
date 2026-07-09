import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { AppToaster } from '../ui/toast';
import { DocumentScreen } from './DocumentScreen';

vi.mock('../api', async (io) => ({
  ...(await io<typeof import('../api')>()),
  getDocuments: vi.fn(),
  getDocumentDetails: vi.fn(),
  fetchDocumentPreviewObjectUrl: vi.fn().mockResolvedValue('blob:x'),
  copyDocumentShareLink: vi.fn(),
  retryDocument: vi.fn(),
  deleteDocument: vi.fn(),
}));
import {
  copyDocumentShareLink,
  deleteDocument,
  getDocumentDetails,
  getDocuments,
  type DocumentArchiveRow,
} from '../api';

const ROW: DocumentArchiveRow = {
  id: 9,
  filename: 'arve-183.pdf',
  mime_type: 'application/pdf',
  size_bytes: 34816,
  status: 'processed',
  processing_since: null,
  created_at: 1751500000,
  preview_path: 'p',
  channel: 'email',
  reason: null,
  reason_type: null,
  expense_id: 12,
  supplier_name: 'AS Merko Ehitus',
  claimant_name: null,
  expense_status: 'posted',
};
const DETAILS = {
  document_id: 9,
  ocr: { ok: true, markdown: '# Arve 183' },
  classification: {
    ok: true,
    result: {
      kind: 'purchase_invoice',
      document_type: 'invoice',
      gross_amount: 65000,
      vat_amount: 11721,
      currency: 'EUR',
      tax_point_date: '2026-06-25',
      category: 'rent',
      document_vat_marking: null,
      supplier_invoice_number: 'A-183',
      confidence: 0.96,
    },
  },
};

function mountAt(row: Partial<typeof ROW> = {}) {
  vi.mocked(getDocuments).mockResolvedValue([{ ...ROW, ...row }] as never);
  vi.mocked(getDocumentDetails).mockResolvedValue(DETAILS as never);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/books/documents/9']}>
        <AppToaster />
        <Routes>
          <Route path="/books/documents/:id" element={<DocumentScreen />} />
          <Route path="/books" element={<div>ARCHIVE</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('DocumentScreen', () => {
  it('renders facts, persisted classification + OCR, and the REAL expense navigation', async () => {
    mountAt();
    expect(await screen.findByText('arve-183.pdf')).toBeInTheDocument();
    expect(screen.getByText('✉ email')).toBeInTheDocument();
    // Linked expense is a route link, not a dead anchor:
    expect(
      screen.getByRole('link', { name: /AS Merko Ehitus/ }),
    ).toHaveAttribute('href', '/books/expenses/12');
    // Persisted classification facts (ADR-0039 — no reclassify call):
    expect(await screen.findByText('rent')).toBeInTheDocument();
    expect(screen.getByText('650.00 € (VAT 117.21 €)')).toBeInTheDocument();
    // OCR collapsible:
    await userEvent.click(screen.getByText(/OCR text/));
    expect(screen.getByText('# Arve 183')).toBeInTheDocument();
  });

  it('Copy link gives a success receipt', async () => {
    vi.mocked(copyDocumentShareLink).mockResolvedValue(undefined);
    mountAt();
    await userEvent.click(
      await screen.findByRole('button', { name: 'Copy link' }),
    );
    await waitFor(() => expect(copyDocumentShareLink).toHaveBeenCalledWith(9));
    expect(
      await screen.findByText(/Link copied — valid ~1 hour/),
    ).toBeInTheDocument();
  });

  it('delete is REPLACED by the guard explanation when the linked expense is posted', async () => {
    mountAt();
    await screen.findByText('arve-183.pdf');
    expect(screen.queryByRole('button', { name: /Delete/ })).toBeNull();
    expect(
      screen.getByText(/evidence for a posted expense/i),
    ).toBeInTheDocument();
  });

  it('deletable documents go plan→confirm→receipt→archive', async () => {
    vi.mocked(deleteDocument).mockResolvedValue({ deleted: 9 } as never);
    mountAt({ expense_id: null, supplier_name: null, expense_status: null });
    await userEvent.click(
      await screen.findByRole('button', { name: 'Delete document…' }),
    );
    expect(deleteDocument).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(deleteDocument).toHaveBeenCalledWith(9));
    expect(await screen.findByText('ARCHIVE')).toBeInTheDocument();
  });

  it('needs_triage documents offer Retry AI and Resolve in Inbox', async () => {
    mountAt({
      status: 'needs_triage',
      reason: 'Unknown supplier',
      reason_type: 'supplier_unresolved',
      expense_id: null,
      expense_status: null,
    });
    expect(
      await screen.findByRole('button', { name: 'Retry AI' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Resolve in Inbox' }),
    ).toHaveAttribute('href', '/inbox/doc/9');
  });
});
