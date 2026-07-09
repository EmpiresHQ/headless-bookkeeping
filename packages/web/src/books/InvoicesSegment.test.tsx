import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { InvoicesSegment } from './InvoicesSegment';

vi.mock('../api', async (io) => ({
  ...(await io<typeof import('../api')>()),
  getInvoices: vi.fn(),
  getEntities: vi.fn(),
}));
import { getEntities, getInvoices } from '../api';

const INVOICES = [
  {
    id: 1,
    customer_id: 7,
    invoice_number: '2026-018',
    gross_amount: 120000,
    vat_amount: 21639,
    currency: 'EUR',
    tax_point_date: '2026-07-04',
    due_date: null,
    document_id: null,
    status: 'posted',
    sent_at: 1751600000,
    reconciled: true,
  },
  {
    id: 2,
    customer_id: null,
    invoice_number: '2026-019',
    gross_amount: 45000,
    vat_amount: 8115,
    currency: 'EUR',
    tax_point_date: '2026-06-20',
    due_date: null,
    document_id: 5,
    status: 'draft',
    sent_at: null,
    reconciled: false,
  },
];
const ENTITIES = [
  {
    id: 7,
    role: 'customer',
    country: 'EE',
    name: 'Nordic Consulting OÜ',
    goods_vs_services: null,
  },
];

function mount(q = '', url = '/books?seg=invoices') {
  vi.mocked(getInvoices).mockResolvedValue(INVOICES as never);
  vi.mocked(getEntities).mockResolvedValue(ENTITIES as never);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[url]}>
        <InvoicesSegment q={q} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('InvoicesSegment', () => {
  it('renders customer-titled rows with number/sent markers and inflow totals', async () => {
    mount();
    expect(await screen.findByText('Nordic Consulting OÜ')).toBeInTheDocument();
    expect(
      screen.getByText(/2026-018 · 4 Jul · 🏦 · sent/),
    ).toBeInTheDocument();
    expect(screen.getByText('+1200.00 € · 1')).toBeInTheDocument();
    // Customer-less draft falls back to the invoice number as its title:
    expect(screen.getByText('2026-019')).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /Nordic Consulting/ }),
    ).toHaveAttribute('href', '/books/invoices/1');
  });

  it('?status= filters and totals follow', async () => {
    mount('', '/books?seg=invoices&status=draft');
    expect(await screen.findByText('2026-019')).toBeInTheDocument();
    expect(screen.queryByText('Nordic Consulting OÜ')).not.toBeInTheDocument();
    expect(screen.getByText('+450.00 € · 1')).toBeInTheDocument();
  });

  it('search matches the invoice number', async () => {
    mount('018');
    expect(await screen.findByText('Nordic Consulting OÜ')).toBeInTheDocument();
    expect(screen.queryByText('2026-019')).not.toBeInTheDocument();
  });
});
