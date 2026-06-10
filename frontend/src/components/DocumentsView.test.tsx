import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DocumentsView } from './DocumentsView';
import * as api from '../api';

vi.mock('../api', () => ({
  getDocuments: vi.fn(),
  getDocumentDebug: vi.fn(),
}));

describe('DocumentsView', () => {
  beforeEach(() => {
    vi.mocked(api.getDocuments).mockResolvedValue([
      {
        id: 1,
        filename: 'creditnote.pdf',
        mime_type: 'application/pdf',
        size_bytes: 2048,
        status: 'needs_triage',
        created_at: 0,
      },
    ]);
    vi.mocked(api.getDocumentDebug).mockResolvedValue({
      document_id: 1,
      ocr: { ok: true, markdown: '# Credit note\nRefund for invoice 100' },
      classification: {
        ok: true,
        result: {
          kind: 'correction',
          document_type: 'invoice',
          gross_amount: -5000,
          vat_amount: -1000,
          currency: 'EUR',
          tax_point_date: '2026-05-01',
          category: 'refund',
          document_vat_marking: '23%',
          confidence: 0.88,
        },
      },
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it('debugs a document, showing the LLM classification + OCR text', async () => {
    render(<DocumentsView />);
    await screen.findByText('creditnote.pdf');

    fireEvent.click(screen.getByRole('button', { name: /debug/i }));

    // The classification kind and the OCR markdown both render.
    expect(await screen.findByText('correction')).toBeInTheDocument();
    expect(
      screen.getByText(/Refund for invoice 100/),
    ).toBeInTheDocument();
    expect(api.getDocumentDebug).toHaveBeenCalledWith(1);
  });
});
