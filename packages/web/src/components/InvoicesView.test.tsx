import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { InvoicesView } from './InvoicesView';
import * as api from '../api';

vi.mock('../api', () => ({
  getInvoices: vi.fn(),
  createInvoice: vi.fn(),
  deleteInvoice: vi.fn(),
  correctInvoice: vi.fn(),
  fmtCents: (c: number) => (c / 100).toFixed(2),
}));

const posted = {
  id: 3,
  customer_id: null,
  invoice_number: 'INV-1',
  gross_amount: 10000,
  vat_amount: 2000,
  currency: 'EUR',
  tax_point_date: '2026-05-01',
  due_date: null,
  document_id: null,
  status: 'posted',
  sent_at: null,
  reconciled: false,
};

describe('InvoicesView', () => {
  beforeEach(() => {
    vi.mocked(api.getInvoices).mockResolvedValue([{ ...posted }]);
    vi.mocked(api.createInvoice).mockResolvedValue({ ...posted, id: 4 });
    vi.mocked(api.correctInvoice).mockResolvedValue({ outcome: 'corrected' });
  });
  afterEach(() => vi.restoreAllMocks());

  it('creates an invoice, converting euros to integer cents', async () => {
    render(<InvoicesView />);
    await screen.findByText('INV-1');

    fireEvent.change(screen.getByLabelText('Invoice number'), {
      target: { value: 'INV-2' },
    });
    fireEvent.change(screen.getByLabelText('Gross'), {
      target: { value: '100.00' },
    });
    fireEvent.change(screen.getByLabelText('VAT'), {
      target: { value: '20.00' },
    });
    fireEvent.change(screen.getByLabelText('Tax point date'), {
      target: { value: '2026-05-02' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^add$/i }));

    expect(api.createInvoice).toHaveBeenCalledWith({
      invoice_number: 'INV-2',
      gross_amount: 10000,
      vat_amount: 2000,
      currency: 'EUR',
      tax_point_date: '2026-05-02',
    });
  });

  it('corrects a posted invoice (no category in the patch)', async () => {
    render(<InvoicesView />);
    await screen.findByText('INV-1');

    fireEvent.click(screen.getByRole('button', { name: /correct/i }));
    fireEvent.change(screen.getByLabelText('Correction reason'), {
      target: { value: 'credit note' },
    });
    fireEvent.click(screen.getByRole('button', { name: /post correction/i }));

    expect(api.correctInvoice).toHaveBeenCalledWith(3, {
      kind: 'financial',
      reason: 'credit note',
      patch: { gross_amount: 10000, vat_amount: 2000 },
    });
  });
});
