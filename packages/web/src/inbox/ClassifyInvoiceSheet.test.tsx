import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  getDocumentReclassify: vi.fn(),
  getEntities: vi.fn(),
  manualClassifyInvoice: vi.fn(),
}));

import * as api from '../api';
import { ClassifyInvoiceSheet } from './ClassifyInvoiceSheet';

function renderSheet(onDone = vi.fn()) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <ClassifyInvoiceSheet
        documentId={12}
        open
        onOpenChange={() => undefined}
        onDone={onDone}
      />
    </QueryClientProvider>,
  );
  return onDone;
}

describe('ClassifyInvoiceSheet', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getDocumentReclassify).mockResolvedValue({
      document_id: 12,
      ocr: { ok: true, markdown: 'INVOICE 2026-018 …' },
      classification: {
        ok: true,
        result: {
          kind: 'outgoing_invoice',
          document_type: 'invoice',
          gross_amount: 120000,
          vat_amount: 0,
          currency: 'EUR',
          tax_point_date: '2026-07-01',
          category: '',
          document_vat_marking: null,
          supplier_invoice_number: '2026-018',
          confidence: 0.6,
        },
      },
    });
    vi.mocked(api.getEntities).mockResolvedValue([
      {
        id: 4,
        role: 'customer',
        country: 'EE',
        name: 'Nordic Consulting OÜ',
        goods_vs_services: null,
      },
    ]);
    vi.mocked(api.manualClassifyInvoice).mockResolvedValue({
      kind: 'invoice',
      document_id: 12,
      invoice_id: 60,
    });
  });

  it('prefills amounts and the invoice number, states the outcome with +amount', async () => {
    renderSheet();
    expect(await screen.findByDisplayValue('1200.00')).toBeInTheDocument();
    expect(screen.getByDisplayValue('2026-018')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Record invoice · +1200.00 €' }),
    ).toBeInTheDocument();
  });

  it('requires the invoice number', async () => {
    renderSheet();
    const nr = await screen.findByDisplayValue('2026-018');
    fireEvent.change(nr, { target: { value: '' } });
    expect(
      screen.getByRole('button', { name: 'Record invoice · +1200.00 €' }),
    ).toBeDisabled();
  });

  it('submits the sales_invoice payload with optional customer', async () => {
    const onDone = renderSheet();
    fireEvent.change(await screen.findByPlaceholderText(/search customers/i), {
      target: { value: 'nordic' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Nordic Consulting/ }));
    fireEvent.click(
      screen.getByRole('button', { name: 'Record invoice · +1200.00 €' }),
    );
    await waitFor(() =>
      expect(api.manualClassifyInvoice).toHaveBeenCalledWith(12, {
        target: 'sales_invoice',
        customer_id: 4,
        invoice_number: '2026-018',
        document_vat_marking: null,
        gross_amount: 120000,
        vat_amount: 0,
        currency: 'EUR',
        tax_point_date: '2026-07-01',
      }),
    );
    expect(onDone).toHaveBeenCalledWith({
      kind: 'invoice',
      document_id: 12,
      invoice_id: 60,
    });
  });
});
