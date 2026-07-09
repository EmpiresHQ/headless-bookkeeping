import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { CreditNotesSegment } from './CreditNotesSegment';
import { CreditNoteScreen } from './CreditNoteScreen';

vi.mock('../api', async (io) => ({
  ...(await io<typeof import('../api')>()),
  listCreditNotes: vi.fn(),
  getCreditNote: vi.fn(),
  getExpenses: vi.fn(),
  getInvoices: vi.fn(),
  getEntities: vi.fn(),
}));
import {
  getCreditNote,
  getEntities,
  getExpenses,
  getInvoices,
  listCreditNotes,
} from '../api';

const NOTE = {
  id: 7,
  credit_note_number: 'CN-1',
  status: 'posted',
  gross_amount: 40000,
  vat_amount: 7213,
  currency: 'EUR',
  tax_point_date: '2026-07-02',
  created_at: 1751400000,
  credits_object_type: 'sales_invoice',
  credits_object_id: 3,
};

function seed() {
  vi.mocked(listCreditNotes).mockResolvedValue([NOTE] as never);
  vi.mocked(getCreditNote).mockResolvedValue(NOTE as never);
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
  ] as never);
  vi.mocked(getExpenses).mockResolvedValue([] as never);
  vi.mocked(getEntities).mockResolvedValue([
    {
      id: 7,
      role: 'customer',
      country: 'EE',
      name: 'Nordic Consulting OÜ',
      goods_vs_services: null,
    },
  ] as never);
}

function mount(ui: ReactElement, url = '/books?seg=credit-notes') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[url]}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Credit notes', () => {
  it('rows are titled by the credited object with context, amount signed against income', async () => {
    seed();
    mount(<CreditNotesSegment q="" />);
    expect(
      await screen.findByText('Nordic Consulting OÜ · Invoice 2026-018'),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/CN-1 · credits invoice · 2 Jul/),
    ).toBeInTheDocument();
    expect(screen.getByText(/-400\.00/)).toBeInTheDocument();
    expect(
      screen.getByRole('link', {
        name: /Nordic Consulting OÜ · Invoice 2026-018/,
      }),
    ).toHaveAttribute('href', '/books/credit-notes/7');
    // Creation reachable from the segment:
    expect(
      screen.getByRole('link', { name: 'New credit note' }),
    ).toHaveAttribute('href', '/books/credit-notes/new');
  });

  it('detail links back to the credited object route', async () => {
    seed();
    mount(
      <Routes>
        <Route path="/books/credit-notes/:id" element={<CreditNoteScreen />} />
      </Routes>,
      '/books/credit-notes/7',
    );
    expect(await screen.findByText('CN-1')).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /Invoice 2026-018/ }),
    ).toHaveAttribute('href', '/books/invoices/3');
  });
});
