import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { AppToaster } from '../ui/toast';
import { InvoiceScreen } from './InvoiceScreen';

vi.mock('../api', async (io) => ({
  ...(await io<typeof import('../api')>()),
  getInvoices: vi.fn(),
  getEntities: vi.fn(),
  listApprovals: vi.fn(),
  postInvoice: vi.fn(),
  deleteInvoice: vi.fn(),
  getCategories: vi.fn(),
}));
import {
  deleteInvoice,
  getCategories,
  getEntities,
  getInvoices,
  listApprovals,
  type SalesInvoice,
} from '../api';

// Typed against SalesInvoice (not inferred) so overrides like
// `sent_at: null` in the draft test type-check against the real
// nullable fields instead of the narrower literal type TS would infer.
const INVOICE: SalesInvoice = {
  id: 3,
  customer_id: 7,
  invoice_number: '2026-018',
  gross_amount: 120000,
  vat_amount: 21639,
  currency: 'EUR',
  tax_point_date: '2026-07-04',
  due_date: '2026-07-18',
  document_id: 5,
  status: 'posted',
  sent_at: 1751600000,
  reconciled: true,
};

function mountAt(
  inv: Partial<typeof INVOICE> = {},
  id = '3',
  rejections: unknown[] = [],
) {
  vi.mocked(getInvoices).mockResolvedValue([{ ...INVOICE, ...inv }] as never);
  vi.mocked(getEntities).mockResolvedValue([
    {
      id: 7,
      role: 'customer',
      country: 'EE',
      name: 'Nordic Consulting OÜ',
      goods_vs_services: null,
    },
  ] as never);
  // MUST be mocked BEFORE render — the rejection query fires on mount.
  vi.mocked(listApprovals).mockResolvedValue(rejections as never);
  vi.mocked(getCategories).mockResolvedValue([] as never);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/books/invoices/${id}`]}>
        <AppToaster />
        <Routes>
          <Route path="/books/invoices/:id" element={<InvoiceScreen />} />
          <Route path="/books" element={<div>BOOKS LIST</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('InvoiceScreen', () => {
  it('renders hero and facts from the LIST row, document link, and both posted actions', async () => {
    mountAt();
    expect(
      await screen.findByText(/Nordic Consulting OÜ · 2026-018/),
    ).toBeInTheDocument();
    expect(screen.getByText('216.39 € (22%)')).toBeInTheDocument();
    expect(screen.getByText('04.07.2026')).toBeInTheDocument();
    expect(screen.getByText('18.07.2026')).toBeInTheDocument();
    expect(screen.getByText('🏦 Reconciled')).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /Source document/ }),
    ).toHaveAttribute('href', '/books/documents/5');
    expect(
      screen.getByRole('button', { name: 'Correct…' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Issue credit note…' }),
    ).toHaveAttribute(
      'href',
      '/books/credit-notes/new?type=sales_invoice&id=3',
    );
  });

  it('drafts: rejection banner + Delete via ConfirmDialog', async () => {
    vi.mocked(deleteInvoice).mockResolvedValue({ id: 3 } as never);
    mountAt({ status: 'draft', sent_at: null, reconciled: false }, '3', [
      {
        id: 9,
        object_type: 'sales_invoice',
        object_id: 3,
        status: 'rejected',
        requested_by: 'system',
        approved_by: null,
        rejected_reason: 'Amount looks wrong',
        policy_reason: null,
        superseded_by: null,
        created_at: 1,
        resolved_at: 2,
      },
    ]);
    expect(await screen.findByText(/Amount looks wrong/)).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole('button', { name: 'Delete draft…' }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(deleteInvoice).toHaveBeenCalledWith(3));
    expect(await screen.findByText('BOOKS LIST')).toBeInTheDocument();
  });

  it('an id absent from the list renders an honest not-found state', async () => {
    mountAt({}, '999');
    expect(await screen.findByText(/not in the books/i)).toBeInTheDocument();
  });
});
