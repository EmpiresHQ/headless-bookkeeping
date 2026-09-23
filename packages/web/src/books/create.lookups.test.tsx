import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
import { sharedKeys } from '../queries/keys';

const CATS = [{ key: 'fuel', label: 'Fuel', accountCode: 'X' }];
const SUP = { id: 5, role: 'supplier', name: 'Neste Eesti', country: 'EE' };
const CUS = { id: 6, role: 'customer', name: 'Acme OÜ', country: 'EE' };

function mount(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <UnsavedChangesProvider onUnauthorized={() => undefined}>
        <MemoryRouter initialEntries={['/books']}>
          <Routes>
            <Route path="/books" element={ui} />
            <Route path="/books/expenses/:id" element={<div>EXP DETAIL</div>} />
            <Route path="/books/invoices/:id" element={<div>INV DETAIL</div>} />
          </Routes>
        </MemoryRouter>
      </UnsavedChangesProvider>
    </QueryClientProvider>,
  );
  return qc;
}

function fillExpense() {
  fireEvent.change(screen.getByLabelText('Gross (€)'), {
    target: { value: '10' },
  });
  fireEvent.change(screen.getByLabelText('Tax point date'), {
    target: { value: '2026-07-01' },
  });
}

const createBtn = () => screen.getByRole('button', { name: /Create expense/ });

describe('create sheets — reference-data states (#260)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('categories 503: the select says unavailable, Create is blocked with a reason, Retry recovers and the input is kept', async () => {
    vi.mocked(getCategories).mockRejectedValueOnce(new Error('HTTP 503'));
    vi.mocked(getEntities).mockResolvedValue([SUP] as never);
    vi.mocked(createExpense).mockResolvedValue({ id: 3 } as never);
    mount(<NewExpenseSheet open onOpenChange={() => undefined} />);
    fillExpense();
    expect(
      await screen.findByText(/Couldn't load categories \(HTTP 503\)/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('option', { name: 'Categories unavailable' }),
    ).toBeInTheDocument();
    expect(createBtn()).toBeDisabled();
    expect(
      screen.getByText("Couldn't load categories — retry above."),
    ).toBeInTheDocument();

    vi.mocked(getCategories).mockResolvedValue(CATS as never);
    fireEvent.click(screen.getByRole('button', { name: 'Retry categories' }));
    await screen.findByRole('option', { name: 'Fuel' });
    // Typed input survived the failure and the retry.
    expect(screen.getByLabelText('Gross (€)')).toHaveValue('10');
    fireEvent.change(screen.getByLabelText('Category'), {
      target: { value: 'fuel' },
    });
    expect(createBtn()).toBeEnabled();
    fireEvent.click(createBtn());
    await waitFor(() =>
      expect(createExpense).toHaveBeenCalledWith(
        expect.objectContaining({ category: 'fuel', supplier_id: null }),
      ),
    );
  });

  it('entities 503: "none" is not an answer until the supplier list loads; a fresh empty list allows it', async () => {
    vi.mocked(getCategories).mockResolvedValue(CATS as never);
    vi.mocked(getEntities).mockRejectedValueOnce(new Error('HTTP 503'));
    mount(<NewExpenseSheet open onOpenChange={() => undefined} />);
    await screen.findByRole('option', { name: 'Fuel' });
    fillExpense();
    fireEvent.change(screen.getByLabelText('Category'), {
      target: { value: 'fuel' },
    });
    expect(
      await screen.findByRole('option', { name: 'Suppliers unavailable' }),
    ).toBeInTheDocument();
    expect(createBtn()).toBeDisabled();
    expect(
      screen.getByText("Couldn't load suppliers — retry above."),
    ).toBeInTheDocument();

    vi.mocked(getEntities).mockResolvedValue([] as never);
    fireEvent.click(screen.getByRole('button', { name: 'Retry suppliers' }));
    expect(
      await screen.findByText(/no suppliers on file yet/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('option', { name: '— none —' }),
    ).toBeInTheDocument();
    expect(createBtn()).toBeEnabled();
  });

  it('a refresh failure keeps the earlier list usable, with a warning', async () => {
    vi.mocked(getCategories).mockResolvedValue(CATS as never);
    vi.mocked(getEntities).mockResolvedValue([SUP] as never);
    const qc = mount(<NewExpenseSheet open onOpenChange={() => undefined} />);
    await screen.findByRole('option', { name: 'Neste Eesti' });
    vi.mocked(getEntities).mockRejectedValueOnce(new Error('HTTP 503'));
    await act(() => qc.refetchQueries({ queryKey: sharedKeys.entities }));
    expect(
      await screen.findByText(/Couldn't refresh suppliers/),
    ).toBeInTheDocument();
    fillExpense();
    fireEvent.change(screen.getByLabelText('Category'), {
      target: { value: 'fuel' },
    });
    fireEvent.change(screen.getByLabelText('Supplier'), {
      target: { value: '5' },
    });
    expect(createBtn()).toBeEnabled();
  });

  it('a supplier or category a refetch drops stays visible as not available and blocks until changed', async () => {
    vi.mocked(getCategories).mockResolvedValue(CATS as never);
    vi.mocked(getEntities).mockResolvedValue([SUP] as never);
    const qc = mount(<NewExpenseSheet open onOpenChange={() => undefined} />);
    await screen.findByRole('option', { name: 'Neste Eesti' });
    fillExpense();
    fireEvent.change(screen.getByLabelText('Category'), {
      target: { value: 'fuel' },
    });
    fireEvent.change(screen.getByLabelText('Supplier'), {
      target: { value: '5' },
    });
    expect(createBtn()).toBeEnabled();

    // The supplier became a customer (role change) and the category vanished.
    vi.mocked(getEntities).mockResolvedValue([
      { ...SUP, role: 'customer' },
    ] as never);
    vi.mocked(getCategories).mockResolvedValue([
      { key: 'meals', label: 'Meals', accountCode: 'Y' },
    ] as never);
    await act(async () => {
      await qc.refetchQueries({ queryKey: sharedKeys.entities });
      await qc.refetchQueries({ queryKey: sharedKeys.categories });
    });
    expect(
      await screen.findByRole('option', {
        name: 'Neste Eesti (not available)',
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('option', { name: 'fuel (not available)' }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Supplier')).toHaveValue('5');
    // The error is tied to the control, not just rendered next to it.
    expect(screen.getByLabelText('Supplier')).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    expect(screen.getByLabelText('Supplier')).toHaveAccessibleDescription(
      'This supplier is no longer available — choose again',
    );
    expect(screen.getByLabelText('Category')).toHaveValue('fuel');
    expect(createBtn()).toBeDisabled();
    expect(
      screen.getByText(
        'The chosen category is no longer available — choose again.',
      ),
    ).toBeInTheDocument();
    expect(createExpense).not.toHaveBeenCalled();
  });

  it('NewInvoiceSheet: customers 503 blocks with a reason and Retry; a dropped customer blocks', async () => {
    vi.mocked(getEntities).mockRejectedValueOnce(new Error('HTTP 503'));
    const qc = mount(<NewInvoiceSheet open onOpenChange={() => undefined} />);
    fireEvent.change(screen.getByLabelText('Invoice number'), {
      target: { value: 'INV-1' },
    });
    fireEvent.change(screen.getByLabelText('Gross (€)'), {
      target: { value: '100' },
    });
    fireEvent.change(screen.getByLabelText('Tax point date'), {
      target: { value: '2026-07-05' },
    });
    const submit = () => screen.getByRole('button', { name: /Create invoice/ });
    expect(
      await screen.findByRole('option', { name: 'Customers unavailable' }),
    ).toBeInTheDocument();
    expect(submit()).toBeDisabled();

    vi.mocked(getEntities).mockResolvedValue([CUS] as never);
    fireEvent.click(screen.getByRole('button', { name: 'Retry customers' }));
    await screen.findByRole('option', { name: 'Acme OÜ' });
    fireEvent.change(screen.getByLabelText('Customer'), {
      target: { value: '6' },
    });
    expect(submit()).toBeEnabled();

    vi.mocked(getEntities).mockResolvedValue([] as never);
    await act(() => qc.refetchQueries({ queryKey: sharedKeys.entities }));
    expect(
      await screen.findByRole('option', { name: 'Acme OÜ (not available)' }),
    ).toBeInTheDocument();
    expect(submit()).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Customer'), {
      target: { value: '' },
    });
    expect(submit()).toBeEnabled();
    expect(screen.getByLabelText('Invoice number')).toHaveValue('INV-1');
    expect(createInvoice).not.toHaveBeenCalled();
  });

  it('a known-empty category list is its own state: stated and blocking, not a bare placeholder', async () => {
    vi.mocked(getCategories).mockResolvedValue([] as never);
    vi.mocked(getEntities).mockResolvedValue([SUP] as never);
    mount(<NewExpenseSheet open onOpenChange={() => undefined} />);
    expect(
      await screen.findByRole('option', { name: 'No categories defined' }),
    ).toBeInTheDocument();
    fillExpense();
    expect(createBtn()).toBeDisabled();
    expect(
      screen.getAllByText(/No expense categories are defined/).length,
    ).toBeGreaterThan(0);
  });
});
