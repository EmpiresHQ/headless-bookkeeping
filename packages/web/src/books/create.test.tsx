import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { AppToaster } from '../ui/toast';
import { NewExpenseSheet, NewInvoiceSheet } from './create';

vi.mock('../api', async (io) => ({
  ...(await io<typeof import('../api')>()),
  createExpense: vi.fn(),
  createInvoice: vi.fn(),
  getCategories: vi.fn(),
  getEntities: vi.fn(),
}));
import {
  createExpense,
  createInvoice,
  getCategories,
  getEntities,
} from '../api';
import { UnsavedChangesProvider } from '../lib/unsavedChanges';

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
      <UnsavedChangesProvider onUnauthorized={() => undefined}>
        <MemoryRouter initialEntries={['/books']}>
          <AppToaster />
          <Routes>
            <Route path="/books" element={ui} />
            <Route path="/books/expenses/:id" element={<div>EXP DETAIL</div>} />
            <Route path="/books/invoices/:id" element={<div>INV DETAIL</div>} />
            <Route
              path="/books/documents/:id"
              element={<div>DOC DETAIL</div>}
            />
          </Routes>
        </MemoryRouter>
      </UnsavedChangesProvider>
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

  it('NewExpenseSheet locks its fields while saving and keeps them after a failure (#251)', async () => {
    vi.clearAllMocks();
    seed();
    let fail!: (e: unknown) => void;
    vi.mocked(createExpense).mockReturnValue(
      new Promise((_, rej) => (fail = rej)) as never,
    );
    mount(<NewExpenseSheet open onOpenChange={() => undefined} />);
    await screen.findByText('Fuel');
    fireEvent.change(screen.getByLabelText('Category'), {
      target: { value: 'fuel' },
    });
    fireEvent.change(screen.getByLabelText('Gross (€)'), {
      target: { value: '123.45' },
    });
    fireEvent.change(screen.getByLabelText('Tax point date'), {
      target: { value: '2026-07-01' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Create expense/ }));
    await waitFor(() =>
      expect(screen.getByLabelText('Gross (€)')).toBeDisabled(),
    );
    await act(async () => fail(new Error('503 Service Unavailable')));
    await waitFor(() =>
      expect(screen.getByLabelText('Gross (€)')).not.toBeDisabled(),
    );
    expect(screen.getByLabelText('Gross (€)')).toHaveValue('123.45');
    expect(
      await screen.findByText(/503 Service Unavailable/),
    ).toBeInTheDocument();
  });
});
