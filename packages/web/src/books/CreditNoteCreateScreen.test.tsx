import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { AppToaster } from '../ui/toast';
import { CreditNoteCreateScreen } from './CreditNoteCreateScreen';

vi.mock('../api', async (io) => ({
  ...(await io<typeof import('../api')>()),
  createCreditNote: vi.fn(),
  listCreditNotes: vi.fn(),
  getExpenses: vi.fn(),
  getInvoices: vi.fn(),
  getEntities: vi.fn(),
}));
import {
  createCreditNote,
  getEntities,
  getExpenses,
  getInvoices,
  listCreditNotes,
} from '../api';

function seed() {
  vi.mocked(listCreditNotes).mockResolvedValue([
    {
      id: 1,
      credit_note_number: 'CN-0',
      status: 'posted',
      gross_amount: 20000,
      vat_amount: 0,
      currency: 'EUR',
      tax_point_date: '2026-06-01',
      created_at: 1,
      credits_object_type: 'sales_invoice',
      credits_object_id: 3,
    },
  ] as never);
  vi.mocked(getInvoices).mockResolvedValue([
    {
      id: 3,
      customer_id: 7,
      invoice_number: '2026-018',
      gross_amount: 120000,
      vat_amount: 21639,
      currency: 'EUR',
      tax_point_date: '2026-07-04',
      due_date: null,
      document_id: null,
      status: 'posted',
      sent_at: null,
      reconciled: false,
    },
    {
      id: 4,
      customer_id: 7,
      invoice_number: '2026-019',
      gross_amount: 5000,
      vat_amount: 0,
      currency: 'EUR',
      tax_point_date: '2026-07-05',
      due_date: null,
      document_id: null,
      status: 'draft',
      sent_at: null,
      reconciled: false,
    },
  ] as never);
  vi.mocked(getExpenses).mockResolvedValue([
    {
      id: 12,
      supplier_id: 9,
      category: 'rent',
      gross_amount: 65000,
      vat_amount: 11721,
      currency: 'EUR',
      tax_point_date: '2026-06-25',
      status: 'posted',
      reconciled: false,
    },
  ] as never);
  vi.mocked(getEntities).mockResolvedValue([
    {
      id: 7,
      role: 'customer',
      country: 'EE',
      name: 'Nordic Consulting OÜ',
      goods_vs_services: null,
    },
    {
      id: 9,
      role: 'supplier',
      country: 'EE',
      name: 'AS Merko Ehitus',
      goods_vs_services: null,
    },
  ] as never);
}

function mount(url = '/books/credit-notes/new') {
  seed();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[url]}>
        <AppToaster />
        <Routes>
          <Route
            path="/books/credit-notes/new"
            element={<CreditNoteCreateScreen />}
          />
          <Route
            path="/books/credit-notes/:id"
            element={<div>NOTE DETAIL</div>}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('CreditNoteCreateScreen', () => {
  it('the picker lists POSTED objects with number · counterparty · amount · outstanding (never an ID input)', async () => {
    mount();
    // Posted invoice with prior CN-0 (200 €) already credited:
    expect(
      await screen.findByText(/2026-018 · Nordic Consulting OÜ/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/1200\.00 € · 1000\.00 € outstanding/),
    ).toBeInTheDocument();
    // Posted expense present, draft invoice absent:
    expect(screen.getByText(/rent · AS Merko Ehitus/)).toBeInTheDocument();
    expect(screen.queryByText(/2026-019/)).toBeNull();
    // No raw ID entry anywhere:
    expect(screen.queryByLabelText(/object id/i)).toBeNull();
  });

  it('?type=&id= preselects the object and the form submits CENTS from euro inputs', async () => {
    vi.mocked(createCreditNote).mockResolvedValue({ id: 8 } as never);
    mount('/books/credit-notes/new?type=sales_invoice&id=3');
    // Preselected summary visible:
    expect(
      await screen.findByText(/2026-018 · Nordic Consulting OÜ/),
    ).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Credit note number'), 'CN-2');
    await userEvent.type(screen.getByLabelText('Gross (€)'), '120,00');
    // VAT auto-derived at 22% while untouched → 21.64; submit states outcome:
    await userEvent.click(
      await screen.findByRole('button', {
        name: 'Issue credit note · −120.00 €',
      }),
    );
    await waitFor(() =>
      expect(createCreditNote).toHaveBeenCalledWith({
        credits_object_type: 'sales_invoice',
        credits_object_id: 3,
        credit_note_number: 'CN-2',
        gross_amount: 12000,
        vat_amount: 2164,
        tax_point_date: '2026-07-04',
      }),
    );
    expect(await screen.findByText('NOTE DETAIL')).toBeInTheDocument();
  });

  it('over-crediting is blocked up front with the outstanding amount in the error', async () => {
    mount('/books/credit-notes/new?type=sales_invoice&id=3');
    await screen.findByText(/2026-018/);
    await userEvent.type(screen.getByLabelText('Credit note number'), 'CN-3');
    await userEvent.type(screen.getByLabelText('Gross (€)'), '1500');
    expect(
      await screen.findByText(/only 1000\.00 € remains creditable/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Issue credit note/ }),
    ).toBeDisabled();
  });
});
