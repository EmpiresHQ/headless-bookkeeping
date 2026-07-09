import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { DocumentsSegment } from './DocumentsSegment';

vi.mock('../api', async (io) => ({
  ...(await io<typeof import('../api')>()),
  getDocuments: vi.fn(),
  fetchDocumentPreviewObjectUrl: vi.fn().mockResolvedValue('blob:x'),
}));
import { fetchDocumentPreviewObjectUrl, getDocuments } from '../api';

const DOCS = [
  {
    id: 9,
    filename: 'arve-183.pdf',
    mime_type: 'application/pdf',
    size_bytes: 1000,
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
  },
  {
    id: 10,
    filename: 'weird.jpg',
    mime_type: 'image/jpeg',
    size_bytes: 500,
    status: 'needs_triage',
    processing_since: null,
    created_at: 1751510000,
    preview_path: null,
    channel: 'telegram',
    reason: 'Unknown supplier',
    reason_type: 'supplier_unresolved',
    expense_id: null,
    supplier_name: null,
    claimant_name: 'Mari Maasikas',
    expense_status: null,
  },
];

function mount(q = '', url = '/books?seg=documents') {
  vi.mocked(getDocuments).mockResolvedValue(DOCS as never);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[url]}>
        <DocumentsSegment q={q} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('DocumentsSegment', () => {
  it('titles rows by supplier (filename only while unrecognized), shows channel + claimant, links the detail', async () => {
    mount();
    expect(await screen.findByText('AS Merko Ehitus')).toBeInTheDocument();
    expect(screen.getByText(/arve-183\.pdf · ✉ email/)).toBeInTheDocument();
    // Unrecognized document falls back to its filename as the title:
    expect(screen.getByText('weird.jpg')).toBeInTheDocument();
    expect(screen.getByText(/Claimant: Mari Maasikas/)).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /AS Merko Ehitus/ }),
    ).toHaveAttribute('href', '/books/documents/9');
  });

  it('offers the REAL status filters only — no fake Discarded chip', async () => {
    mount();
    await screen.findByText('AS Merko Ehitus');
    expect(
      screen.getByRole('button', { name: /Needs triage 1/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Processed 1/ }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Discarded/)).toBeNull();
  });

  it('?dstatus=needs_triage filters the list', async () => {
    mount('', '/books?seg=documents&dstatus=needs_triage');
    expect(await screen.findByText('weird.jpg')).toBeInTheDocument();
    expect(screen.queryByText('AS Merko Ehitus')).toBeNull();
  });

  it('DocThumb only fetches a preview for rows WITH a preview_path — a null preview_path never fires the authenticated request', async () => {
    vi.mocked(fetchDocumentPreviewObjectUrl).mockClear();
    mount();
    await screen.findByText('AS Merko Ehitus');
    await screen.findByText('weird.jpg');
    // Doc 9 has preview_path 'p' → fetched.
    await waitFor(() =>
      expect(fetchDocumentPreviewObjectUrl).toHaveBeenCalledWith(9),
    );
    // Doc 10 has preview_path: null → never fetched, and no other row fetches.
    expect(fetchDocumentPreviewObjectUrl).not.toHaveBeenCalledWith(10);
    expect(fetchDocumentPreviewObjectUrl).toHaveBeenCalledTimes(1);
  });
});
