import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { AppToaster } from '../ui/toast';
import { NewExpenseSheet, NewInvoiceSheet, UploadSheet } from './create';

vi.mock('../api', async (io) => ({
  ...(await io<typeof import('../api')>()),
  createExpense: vi.fn(),
  createInvoice: vi.fn(),
  uploadDocument: vi.fn(),
  triageDocument: vi.fn(),
  getCategories: vi.fn(),
  getEntities: vi.fn(),
}));
import {
  createExpense,
  createInvoice,
  getCategories,
  getEntities,
  triageDocument,
  uploadDocument,
} from '../api';

function seed(entities: unknown[] = []) {
  vi.mocked(getCategories).mockResolvedValue([
    { key: 'fuel', label: 'Fuel', accountCode: 'X' },
  ] as never);
  vi.mocked(getEntities).mockResolvedValue(entities as never);
}

function mount(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/books']}>
        <AppToaster />
        <Routes>
          <Route path="/books" element={ui} />
          <Route path="/books/expenses/:id" element={<div>EXP DETAIL</div>} />
          <Route path="/books/invoices/:id" element={<div>INV DETAIL</div>} />
          <Route path="/books/documents/:id" element={<div>DOC DETAIL</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('create flows', () => {
  it('NewExpenseSheet: euros in, VAT auto at 22%, outcome-stating submit, navigates to the draft', async () => {
    seed();
    vi.mocked(createExpense).mockResolvedValue({ id: 31 } as never);
    mount(<NewExpenseSheet open onOpenChange={() => undefined} />);
    // The Category label is present on mount; the <option>s only exist once
    // the categories query settles (same race as TxCreateExpense.test.tsx).
    await screen.findByText('Fuel');
    // fireEvent throughout (not userEvent): any userEvent interaction inside
    // the vaul Drawer dispatches real pointerdown/up events that trip its
    // drag handlers, which call setPointerCapture — unimplemented in jsdom
    // (see CorrectSheet.test.tsx / ClassifyExpenseSheet.test.tsx).
    fireEvent.change(screen.getByLabelText('Category'), {
      target: { value: 'fuel' },
    });
    fireEvent.change(screen.getByLabelText('Gross (€)'), {
      target: { value: '48,20' },
    });
    fireEvent.change(screen.getByLabelText('Tax point date'), {
      target: { value: '2026-07-01' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Create expense · −48.20 €' }),
    );
    await waitFor(() =>
      expect(createExpense).toHaveBeenCalledWith({
        category: 'fuel',
        gross_amount: 4820,
        vat_amount: 869, // 22% inside 48.20
        currency: 'EUR',
        tax_point_date: '2026-07-01',
        supplier_id: null,
      }),
    );
    expect(await screen.findByText('EXP DETAIL')).toBeInTheDocument();
  });

  it('NewInvoiceSheet requires the number and navigates to the draft', async () => {
    seed();
    vi.mocked(createInvoice).mockResolvedValue({ id: 8 } as never);
    mount(<NewInvoiceSheet open onOpenChange={() => undefined} />);
    const submit = await screen.findByRole('button', {
      name: /Create invoice/,
    });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Invoice number'), {
      target: { value: '2026-020' },
    });
    fireEvent.change(screen.getByLabelText('Gross (€)'), {
      target: { value: '500' },
    });
    fireEvent.change(screen.getByLabelText('Tax point date'), {
      target: { value: '2026-07-05' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Create invoice · +500.00 €' }),
    );
    await waitFor(() =>
      expect(createInvoice).toHaveBeenCalledWith({
        invoice_number: '2026-020',
        gross_amount: 50000,
        vat_amount: 9016,
        currency: 'EUR',
        tax_point_date: '2026-07-05',
        customer_id: null,
        due_date: null,
      }),
    );
    expect(await screen.findByText('INV DETAIL')).toBeInTheDocument();
  });

  it('UploadSheet sends the claimant and lands on the document detail', async () => {
    seed([
      {
        id: 5,
        role: 'employee',
        country: 'EE',
        name: 'Mari Maasikas',
        goods_vs_services: null,
      },
    ]);
    vi.mocked(uploadDocument).mockResolvedValue({
      document: { id: 77 },
      deduplicated: false,
    } as never);
    vi.mocked(triageDocument).mockResolvedValue({
      kind: 'expense',
      document_id: 77,
      expense_id: 31,
    } as never);
    mount(<UploadSheet open onOpenChange={() => undefined} />);
    fireEvent.change(await screen.findByLabelText('Paid by (claimant)'), {
      target: { value: '5' },
    });
    const file = new File(['x'], 'r.pdf', { type: 'application/pdf' });
    fireEvent.change(screen.getByLabelText('File'), {
      target: { files: [file] },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Upload & process' }));
    await waitFor(() =>
      expect(uploadDocument).toHaveBeenCalledWith(file, { claimantId: 5 }),
    );
    await waitFor(() => expect(triageDocument).toHaveBeenCalledWith(77));
    expect(await screen.findByText('DOC DETAIL')).toBeInTheDocument();
  });

  it('UploadSheet hides the claimant dropdown when no employee/director exists', async () => {
    seed([
      {
        id: 6,
        role: 'supplier',
        country: 'EE',
        name: 'X',
        goods_vs_services: null,
      },
    ]);
    mount(<UploadSheet open onOpenChange={() => undefined} />);
    expect(await screen.findByLabelText('File')).toBeInTheDocument();
    expect(screen.queryByLabelText('Paid by (claimant)')).toBeNull();
  });
});
