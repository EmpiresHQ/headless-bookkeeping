import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  getDocumentReclassify: vi.fn(),
  getCategories: vi.fn(),
  getEntities: vi.fn(),
  getExpenses: vi.fn(),
  manualClassify: vi.fn(),
}));

import * as api from '../api';
import { ClassifyExpenseSheet } from './ClassifyExpenseSheet';

function renderSheet(onDone = vi.fn()) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <ClassifyExpenseSheet
        documentId={12}
        open
        onOpenChange={() => undefined}
        onDone={onDone}
      />
    </QueryClientProvider>,
  );
  return onDone;
}

describe('ClassifyExpenseSheet', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getDocumentReclassify).mockResolvedValue({
      document_id: 12,
      ocr: { ok: true, markdown: 'CIRCLE K …' },
      classification: {
        ok: true,
        result: {
          kind: 'new_expense',
          document_type: 'receipt',
          gross_amount: 4820,
          vat_amount: 867,
          currency: 'EUR',
          tax_point_date: '2026-07-01',
          category: 'fuel',
          document_vat_marking: null,
          supplier_invoice_number: null,
          confidence: 0.41,
        },
      },
    });
    vi.mocked(api.getCategories).mockResolvedValue([
      { key: 'fuel', label: 'Fuel', accountCode: '5000' },
      { key: 'meals', label: 'Meals', accountCode: '5100' },
      { key: 'office', label: 'Office', accountCode: '5200' },
      { key: 'transport', label: 'Transport', accountCode: '5300' },
      { key: 'software', label: 'Software & IT', accountCode: '5400' },
    ]);
    vi.mocked(api.getEntities).mockResolvedValue([
      {
        id: 3,
        role: 'supplier',
        country: 'EE',
        name: 'Circle K Eesti AS',
        goods_vs_services: null,
      },
    ]);
    vi.mocked(api.getExpenses).mockResolvedValue([
      {
        id: 1,
        supplier_id: 3,
        category: 'fuel',
        gross_amount: 1,
        vat_amount: 0,
        currency: 'EUR',
        tax_point_date: '2026-06-01',
        supplier_invoice_number: null,
        status: 'posted',
        reconciled: false,
      },
      {
        id: 2,
        supplier_id: 3,
        category: 'fuel',
        gross_amount: 1,
        vat_amount: 0,
        currency: 'EUR',
        tax_point_date: '2026-06-15',
        supplier_invoice_number: null,
        status: 'posted',
        reconciled: false,
      },
      {
        id: 3,
        supplier_id: 3,
        category: 'office',
        gross_amount: 1,
        vat_amount: 0,
        currency: 'EUR',
        tax_point_date: '2026-05-01',
        supplier_invoice_number: null,
        status: 'posted',
        reconciled: false,
      },
    ]);
    vi.mocked(api.manualClassify).mockResolvedValue({
      kind: 'expense',
      document_id: 12,
      expense_id: 700,
    });
  });

  it('prefills amounts, date and category from the AI run and states the outcome on the button', async () => {
    renderSheet();
    expect(await screen.findByDisplayValue('48.20')).toBeInTheDocument();
    expect(screen.getByDisplayValue('8.67')).toBeInTheDocument();
    expect(screen.getByDisplayValue('2026-07-01')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Create expense · −48.20 €' }),
    ).toBeInTheDocument();
    // Predicted category chip is selected.
    expect(screen.getByRole('button', { name: 'Fuel' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('auto-computes VAT at 22% while the VAT field is untouched, then stops', async () => {
    renderSheet();
    const gross = await screen.findByLabelText(/amount \(eur\)/i);
    fireEvent.change(gross, { target: { value: '100.00' } });
    // 10000 * 22 / 122 = 1803
    expect(screen.getByDisplayValue('18.03')).toBeInTheDocument();
    // Exact-string match: a /vat/i regex would also hit "VAT marking".
    const vat = screen.getByLabelText('VAT');
    fireEvent.change(vat, { target: { value: '0.00' } });
    fireEvent.change(gross, { target: { value: '50.00' } });
    expect(screen.getByDisplayValue('0.00')).toBeInTheDocument(); // manual VAT kept
  });

  it('shows the "usually" hint from the supplier history once a supplier is picked', async () => {
    renderSheet();
    fireEvent.change(await screen.findByPlaceholderText(/search suppliers/i), {
      target: { value: 'circle' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Circle K Eesti AS/ }));
    expect(
      await screen.findByText('Usually Fuel · 2 of 3'),
    ).toBeInTheDocument();
  });

  it('disables submit without a supplier, submits cents payload once valid', async () => {
    const onDone = renderSheet();
    const submit = await screen.findByRole('button', {
      name: 'Create expense · −48.20 €',
    });
    expect(submit).toBeDisabled(); // no supplier yet
    fireEvent.change(screen.getByPlaceholderText(/search suppliers/i), {
      target: { value: 'circle' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Circle K Eesti AS/ }));
    await waitFor(() => expect(submit).toBeEnabled());
    fireEvent.click(submit);
    await waitFor(() =>
      expect(api.manualClassify).toHaveBeenCalledWith(12, {
        supplier_id: 3,
        category: 'fuel',
        document_vat_marking: null,
        gross_amount: 4820,
        vat_amount: 867,
        currency: 'EUR',
        tax_point_date: '2026-07-01',
        supplier_invoice_number: null,
      }),
    );
    expect(onDone).toHaveBeenCalledWith({
      kind: 'expense',
      document_id: 12,
      expense_id: 700,
    });
  });

  it('expands the full category list behind "All…"', async () => {
    renderSheet();
    await screen.findByDisplayValue('48.20');
    fireEvent.click(screen.getByRole('button', { name: 'All…' }));
    expect(
      screen.getByRole('button', { name: 'Software & IT' }),
    ).toBeInTheDocument();
  });
});
