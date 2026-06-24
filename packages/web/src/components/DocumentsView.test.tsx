import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { DocumentsView } from './DocumentsView';
import * as api from '../api';
import type { DocumentArchiveRow, DocumentDetails } from '../api';

vi.mock('../api', () => ({
  getDocuments: vi.fn(),
  getDocumentDetails: vi.fn(),
  deleteDocument: vi.fn(),
}));

/** A minimal archive row for a pending doc (no linkage). */
const pendingDoc: DocumentArchiveRow = {
  id: 1,
  filename: 'receipt.pdf',
  mime_type: 'application/pdf',
  size_bytes: 2048,
  status: 'pending',
  processing_since: null,
  created_at: Math.floor(Date.now() / 1000) - 7200, // 2 h ago
  preview_path: '1/previews/abc.png',
  channel: 'upload',
  reason: null,
  reason_type: null,
  expense_id: null,
  supplier_name: null,
  claimant_name: null,
  expense_status: null,
};

/** A needs_triage doc with OCR-failed reason. */
const needsTriageDoc: DocumentArchiveRow = {
  id: 2,
  filename: 'invoice.jpg',
  mime_type: 'image/jpeg',
  size_bytes: 1024,
  status: 'needs_triage',
  processing_since: null,
  created_at: Math.floor(Date.now() / 1000) - 3600,
  preview_path: null, // no preview
  channel: 'telegram',
  reason: 'OCR produced no text',
  reason_type: 'ocr_failed',
  expense_id: null,
  supplier_name: null,
  claimant_name: null,
  expense_status: null,
};

/** A processed+posted doc linked to an expense. */
const processedDoc: DocumentArchiveRow = {
  id: 3,
  filename: 'bill.pdf',
  mime_type: 'application/pdf',
  size_bytes: 4096,
  status: 'processed',
  processing_since: null,
  created_at: Math.floor(Date.now() / 1000) - 86400,
  preview_path: '3/previews/xyz.png',
  channel: 'email',
  reason: null,
  reason_type: null,
  expense_id: 42,
  supplier_name: 'Acme Corp',
  claimant_name: null,
  expense_status: 'posted',
};

/** A processed doc with a claimant (paid out of pocket). */
const claimantDoc: DocumentArchiveRow = {
  id: 4,
  filename: 'taxi.pdf',
  mime_type: 'application/pdf',
  size_bytes: 512,
  status: 'processed',
  processing_since: null,
  created_at: Math.floor(Date.now() / 1000) - 3600,
  preview_path: null,
  channel: 'ios_photo_library',
  reason: null,
  reason_type: null,
  expense_id: 55,
  supplier_name: 'City Taxi',
  claimant_name: 'Jane Doe',
  expense_status: 'draft',
};

const sampleDetails: DocumentDetails = {
  document_id: 1,
  ocr: { ok: true, markdown: '# Receipt\nTotal: 100.00' },
  classification: {
    ok: true,
    result: {
      kind: 'expense',
      document_type: 'receipt',
      gross_amount: 10000,
      vat_amount: 2000,
      currency: 'EUR',
      tax_point_date: '2026-01-01',
      category: 'travel',
      document_vat_marking: '20%',
      supplier_invoice_number: null,
      confidence: 0.95,
    },
  },
};

describe('DocumentsView', () => {
  beforeEach(() => {
    vi.mocked(api.getDocuments).mockResolvedValue([pendingDoc]);
    vi.mocked(api.getDocumentDetails).mockResolvedValue(sampleDetails);
    vi.mocked(api.deleteDocument).mockResolvedValue({ deleted: 1 });
  });
  afterEach(() => vi.restoreAllMocks());

  // ── Thumbnail ────────────────────────────────────────────────────────────

  it('renders thumbnail img with preview URL when preview_path is set', async () => {
    render(<DocumentsView />);
    await screen.findByText('receipt.pdf');
    const img = screen.getByRole('img', { name: /preview/i });
    expect(img).toHaveAttribute('src', '/api/documents/1/preview');
  });

  it('shows a fallback icon when the thumbnail img errors (no preview)', async () => {
    vi.mocked(api.getDocuments).mockResolvedValue([needsTriageDoc]);
    render(<DocumentsView />);
    await screen.findByText('invoice.jpg');
    // There is an img element; trigger its error event to simulate 404
    const img = screen.getByRole('img', { name: /preview/i });
    fireEvent.error(img);
    // After error, a fallback icon (aria-label="no preview") should appear
    await waitFor(() =>
      expect(screen.getByLabelText('no preview')).toBeInTheDocument(),
    );
  });

  it('clicking filename opens the file URL in a new tab', async () => {
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
    render(<DocumentsView />);
    const link = await screen.findByRole('link', { name: /receipt\.pdf/i });
    expect(link).toHaveAttribute('href', '/api/documents/1/file');
    expect(link).toHaveAttribute('target', '_blank');
    openSpy.mockRestore();
  });

  // ── Added (relative time) ────────────────────────────────────────────────

  it('shows relative time for created_at (e.g. "2h ago")', async () => {
    render(<DocumentsView />);
    await screen.findByText('receipt.pdf');
    // Should show something like "2h ago" — just check it contains "ago"
    expect(screen.getByText(/ago/i)).toBeInTheDocument();
  });

  // ── Status + reason badge ────────────────────────────────────────────────

  it('shows reason badge for needs_triage rows', async () => {
    vi.mocked(api.getDocuments).mockResolvedValue([needsTriageDoc]);
    render(<DocumentsView />);
    await screen.findByText('invoice.jpg');
    expect(screen.getByText(/✗ OCR failed/)).toBeInTheDocument();
  });

  it('does NOT show reason badge for pending rows', async () => {
    render(<DocumentsView />);
    await screen.findByText('receipt.pdf');
    expect(screen.queryByText(/OCR failed/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Unknown supplier/)).not.toBeInTheDocument();
  });

  // ── Channel icon ─────────────────────────────────────────────────────────

  it('shows channel indicator', async () => {
    render(<DocumentsView />);
    await screen.findByText('receipt.pdf');
    // Should show "upload" channel label
    expect(screen.getByText(/upload/i)).toBeInTheDocument();
  });

  // ── Linked (Supplier + Expense + Claimant) ───────────────────────────────

  it('shows Supplier name and Expense #N for a triaged+linked doc', async () => {
    vi.mocked(api.getDocuments).mockResolvedValue([processedDoc]);
    render(<DocumentsView />);
    await screen.findByText('bill.pdf');
    expect(screen.getByText(/Acme Corp/)).toBeInTheDocument();
    expect(screen.getByText(/Expense #42/)).toBeInTheDocument();
  });

  it('shows Claimant badge when claimant_name is set', async () => {
    vi.mocked(api.getDocuments).mockResolvedValue([claimantDoc]);
    render(<DocumentsView />);
    await screen.findByText('taxi.pdf');
    expect(screen.getByText(/Jane Doe/)).toBeInTheDocument();
    expect(screen.getByText(/Expense #55/)).toBeInTheDocument();
  });

  it('shows nothing in Linked column for unlinked docs', async () => {
    render(<DocumentsView />);
    await screen.findByText('receipt.pdf');
    expect(screen.queryByText(/Expense #/)).not.toBeInTheDocument();
  });

  // ── Actions ───────────────────────────────────────────────────────────────

  it('Open in Intake shows for pending docs', async () => {
    render(<DocumentsView />);
    await screen.findByText('receipt.pdf');
    expect(
      screen.getByRole('link', { name: /open in intake/i }),
    ).toBeInTheDocument();
  });

  it('Open in Intake shows for needs_triage docs', async () => {
    vi.mocked(api.getDocuments).mockResolvedValue([needsTriageDoc]);
    render(<DocumentsView />);
    await screen.findByText('invoice.jpg');
    expect(
      screen.getByRole('link', { name: /open in intake/i }),
    ).toBeInTheDocument();
  });

  it('Open in Intake is NOT shown for processed/triaged docs', async () => {
    vi.mocked(api.getDocuments).mockResolvedValue([processedDoc]);
    render(<DocumentsView />);
    await screen.findByText('bill.pdf');
    expect(
      screen.queryByRole('link', { name: /open in intake/i }),
    ).not.toBeInTheDocument();
  });

  it('Open in Intake links to /intake?expand=:id', async () => {
    render(<DocumentsView />);
    await screen.findByText('receipt.pdf');
    const link = screen.getByRole('link', { name: /open in intake/i });
    expect(link).toHaveAttribute('href', '/intake?expand=1');
  });

  it('Delete is disabled with tooltip when expense_status is posted', async () => {
    vi.mocked(api.getDocuments).mockResolvedValue([processedDoc]);
    render(<DocumentsView />);
    await screen.findByText('bill.pdf');
    const deleteBtn = screen.getByRole('button', { name: /delete/i });
    expect(deleteBtn).toBeDisabled();
    expect(deleteBtn).toHaveAttribute('title');
    expect(deleteBtn.getAttribute('title')).toMatch(/posted/i);
  });

  it('Delete is enabled when expense_status is not posted/reversed', async () => {
    render(<DocumentsView />);
    await screen.findByText('receipt.pdf');
    const deleteBtn = screen.getByRole('button', { name: /delete/i });
    expect(deleteBtn).not.toBeDisabled();
  });

  it('deletes a document after confirmation and reloads', async () => {
    vi.mocked(api.getDocuments)
      .mockResolvedValueOnce([pendingDoc])
      .mockResolvedValue([]);
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(<DocumentsView />);
    await screen.findByText('receipt.pdf');

    fireEvent.click(screen.getByRole('button', { name: /delete/i }));

    await waitFor(() => expect(api.deleteDocument).toHaveBeenCalledWith(1));
    await waitFor(() =>
      expect(screen.queryByText('receipt.pdf')).not.toBeInTheDocument(),
    );
    confirmSpy.mockRestore();
  });

  // ── Details panel (replaces old Debug) ───────────────────────────────────

  it('opens read-only Details panel using getDocumentDetails', async () => {
    render(<DocumentsView />);
    await screen.findByText('receipt.pdf');

    fireEvent.click(screen.getByRole('button', { name: /details/i }));

    expect(await screen.findByText(/Total: 100\.00/)).toBeInTheDocument();
    expect(api.getDocumentDetails).toHaveBeenCalledWith(1);
  });

  // ── Columns: Size and Type are removed ───────────────────────────────────

  it('does NOT render Size or Type column headers', async () => {
    render(<DocumentsView />);
    await screen.findByText('receipt.pdf');
    expect(screen.queryByText('Size')).not.toBeInTheDocument();
    expect(screen.queryByText('Type')).not.toBeInTheDocument();
  });
});
