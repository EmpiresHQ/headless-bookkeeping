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
  getOrganization: vi.fn(),
  onboardEntity: vi.fn(),
}));
import {
  createExpense,
  createInvoice,
  getCategories,
  getEntities,
  getOrganization,
  onboardEntity,
} from '../api';
import { setToken } from '../auth';
import { UnsavedChangesProvider } from '../lib/unsavedChanges';
import { sharedKeys } from '../queries/keys';

/**
 * Issue #263: the counterparty of a manual expense/invoice is found or
 * added inside the form — role fixed by the form, typed input kept, the
 * accepted create never replayed, and every #250/#251/#260 rule kept.
 */

const CATS = [{ key: 'fuel', label: 'Fuel', accountCode: 'X' }];
const SUP = { id: 5, role: 'supplier', name: 'Neste Eesti', country: 'EE' };
const SUP2 = { id: 7, role: 'supplier', name: 'Circle K', country: 'EE' };
const CUS = { id: 6, role: 'customer', name: 'Acme OÜ', country: 'EE' };
const NEW_SUP = {
  id: 42,
  role: 'supplier',
  name: 'Uus Tarnija',
  country: 'EE',
};

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function mount(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
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
  return { qc, ...view };
}

const createExpenseBtn = () =>
  screen.getByRole('button', { name: /Create expense/ });
const addBtn = (who = 'supplier') =>
  screen.getByRole('button', { name: `Add ${who}` });

async function fillExpense() {
  await screen.findByRole('option', { name: 'Fuel' });
  fireEvent.change(screen.getByLabelText('Category'), {
    target: { value: 'fuel' },
  });
  fireEvent.change(screen.getByLabelText('Gross (€)'), {
    target: { value: '48,20' },
  });
  fireEvent.change(screen.getByLabelText('Tax point date'), {
    target: { value: '2026-07-01' },
  });
}

function expectExpenseKept() {
  expect(screen.getByLabelText('Category')).toHaveValue('fuel');
  expect(screen.getByLabelText('Gross (€)')).toHaveValue('48,20');
  expect(screen.getByLabelText('Tax point date')).toHaveValue('2026-07-01');
}

function openNew(who = 'supplier', search?: string) {
  if (search !== undefined) {
    fireEvent.change(
      screen.getByLabelText(who[0].toUpperCase() + who.slice(1)),
      {
        target: { value: search },
      },
    );
  }
  fireEvent.click(screen.getByRole('button', { name: `New ${who}…` }));
}

/** Registration key typed; waits for the organization's country default
 *  (the Add button needs a country). */
async function fillNew(regKey = 'EE100200300') {
  await waitFor(() =>
    expect(screen.getByLabelText('Country')).toHaveValue('EE'),
  );
  fireEvent.change(screen.getByLabelText('Registration key'), {
    target: { value: regKey },
  });
}

/** A native submit of the form a rendered submit button belongs to
 *  (issue #266: `requestSubmit()` ignores the disabled state a re-render
 *  gives the button, so only the form's own guards stop it). */
function submitFormOf(el: HTMLElement): () => void {
  const form = (el as HTMLButtonElement).form;
  if (form === null) throw new Error('button has no form owner');
  return () => form.requestSubmit();
}

describe('manual create — find or add the counterparty in the form (#263)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    sessionStorage.clear();
    setToken('session-a');
    vi.mocked(getCategories).mockResolvedValue(CATS as never);
    vi.mocked(getOrganization).mockResolvedValue({ country: 'EE' } as never);
  });

  it('search filters the supplier list and a pick is what the draft sends', async () => {
    vi.mocked(getEntities).mockResolvedValue([SUP, SUP2, CUS] as never);
    vi.mocked(createExpense).mockResolvedValue({ id: 31 } as never);
    mount(<NewExpenseSheet open onOpenChange={() => undefined} />);
    await fillExpense();
    await screen.findByRole('button', { name: /Neste Eesti/ });
    // Role-filtered: a customer is never offered for an expense.
    expect(screen.queryByRole('button', { name: /Acme/ })).toBeNull();
    fireEvent.change(screen.getByLabelText('Supplier'), {
      target: { value: 'circle' },
    });
    expect(screen.queryByRole('button', { name: /Neste Eesti/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Circle K/ }));
    expect(screen.getByRole('group', { name: 'Supplier' })).toHaveTextContent(
      'Circle K · EE · #7',
    );
    fireEvent.click(createExpenseBtn());
    await waitFor(() =>
      expect(createExpense).toHaveBeenCalledWith(
        expect.objectContaining({ supplier_id: 7, gross_amount: 4820 }),
      ),
    );
  });

  it('adds a supplier inline: role fixed, facts sent once, picked automatically, parent input kept', async () => {
    vi.mocked(getEntities).mockResolvedValue([SUP] as never);
    vi.mocked(onboardEntity).mockImplementation(async () => {
      vi.mocked(getEntities).mockResolvedValue([SUP, NEW_SUP] as never);
      return NEW_SUP as never;
    });
    vi.mocked(createExpense).mockResolvedValue({ id: 31 } as never);
    mount(<NewExpenseSheet open onOpenChange={() => undefined} />);
    await fillExpense();
    await screen.findByRole('button', { name: /Neste Eesti/ });
    openNew('supplier', 'Uus Tarnija');
    // No role choice anywhere — the form decides it.
    expect(screen.queryByLabelText('Role')).toBeNull();
    // Seeded from the search; the org country is the known default.
    expect(screen.getByLabelText('Name')).toHaveValue('Uus Tarnija');
    await waitFor(() =>
      expect(screen.getByLabelText('Country')).toHaveValue('EE'),
    );
    await fillNew();
    fireEvent.change(screen.getByLabelText('Goods or services'), {
      target: { value: 'services' },
    });
    fireEvent.change(screen.getByLabelText('Tax status'), {
      target: { value: 'taxable_business' },
    });
    // While the add is open the draft cannot be saved with no supplier.
    expect(createExpenseBtn()).toBeDisabled();
    expect(
      screen.getByText(/Finish adding the new supplier, or discard it/),
    ).toBeInTheDocument();
    fireEvent.click(addBtn());
    await waitFor(() =>
      expect(screen.getByRole('group', { name: 'Supplier' })).toHaveTextContent(
        'Uus Tarnija · EE · #42',
      ),
    );
    expect(onboardEntity).toHaveBeenCalledTimes(1);
    expect(onboardEntity).toHaveBeenCalledWith({
      role: 'supplier',
      name: 'Uus Tarnija',
      country: 'EE',
      registrationKey: 'EE100200300',
      goodsVsServices: 'services',
      taxStatus: 'taxable_business',
    });
    expectExpenseKept();
    expect(createExpenseBtn()).toBeEnabled();
    fireEvent.click(createExpenseBtn());
    await waitFor(() =>
      expect(createExpense).toHaveBeenCalledWith(
        expect.objectContaining({ supplier_id: 42, category: 'fuel' }),
      ),
    );
    await screen.findByText('EXP DETAIL');
  });

  it('NewInvoiceSheet adds a CUSTOMER — never a supplier or employee — and keeps the invoice input', async () => {
    vi.mocked(getEntities).mockResolvedValue([CUS, SUP] as never);
    const NEW_CUS = { ...NEW_SUP, id: 43, role: 'customer' };
    vi.mocked(onboardEntity).mockResolvedValue(NEW_CUS as never);
    vi.mocked(createInvoice).mockResolvedValue({ id: 9 } as never);
    mount(<NewInvoiceSheet open onOpenChange={() => undefined} />);
    fireEvent.change(screen.getByLabelText('Invoice number'), {
      target: { value: 'INV-7' },
    });
    fireEvent.change(screen.getByLabelText('Gross (€)'), {
      target: { value: '100' },
    });
    fireEvent.change(screen.getByLabelText('Tax point date'), {
      target: { value: '2026-07-05' },
    });
    fireEvent.change(screen.getByLabelText('Due date'), {
      target: { value: '2026-08-05' },
    });
    await screen.findByRole('button', { name: /Acme OÜ/ });
    expect(screen.queryByRole('button', { name: /Neste/ })).toBeNull();
    openNew('customer', 'Uus Tarnija');
    expect(screen.queryByLabelText('Role')).toBeNull();
    expect(screen.queryByLabelText('Email')).toBeNull();
    await fillNew('EE999');
    fireEvent.click(addBtn('customer'));
    await waitFor(() =>
      expect(screen.getByRole('group', { name: 'Customer' })).toHaveTextContent(
        '#43',
      ),
    );
    expect(onboardEntity).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'customer', registrationKey: 'EE999' }),
    );
    expect(screen.getByLabelText('Invoice number')).toHaveValue('INV-7');
    expect(screen.getByLabelText('Gross (€)')).toHaveValue('100');
    expect(screen.getByLabelText('Due date')).toHaveValue('2026-08-05');
    fireEvent.click(screen.getByRole('button', { name: /Create invoice/ }));
    await waitFor(() =>
      expect(createInvoice).toHaveBeenCalledWith(
        expect.objectContaining({ customer_id: 43, invoice_number: 'INV-7' }),
      ),
    );
  });

  it('Back to search keeps the started add (even a tax-status-only change) and blocks until it is continued, discarded or replaced by a pick', async () => {
    vi.mocked(getEntities).mockResolvedValue([SUP] as never);
    mount(<NewExpenseSheet open onOpenChange={() => undefined} />);
    await fillExpense();
    await screen.findByRole('button', { name: /Neste Eesti/ });
    openNew();
    // Only a select changed — still a started add.
    fireEvent.change(screen.getByLabelText('Tax status'), {
      target: { value: 'non_taxable' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Back to search' }));
    expect(
      screen.getByText(/The new supplier you started is not added yet/),
    ).toBeInTheDocument();
    expect(createExpenseBtn()).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Continue adding' }));
    expect(screen.getByLabelText('Tax status')).toHaveValue('non_taxable');
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'Half typed' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Back to search' }));
    expect(screen.getByText(/“Half typed”/)).toBeInTheDocument();
    // Discard is the explicit "none".
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(createExpenseBtn()).toBeEnabled();
    openNew();
    expect(screen.getByLabelText('Name')).toHaveValue('');
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'Other' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Back to search' }));
    // A pick replaces the unfinished add.
    fireEvent.click(screen.getByRole('button', { name: /Neste Eesti/ }));
    expect(createExpenseBtn()).toBeEnabled();
    expect(onboardEntity).not.toHaveBeenCalled();
    expectExpenseKept();
  });

  it('an accepted add whose list refresh fails stays picked and is never sent again', async () => {
    vi.mocked(getEntities).mockResolvedValue([SUP] as never);
    vi.mocked(onboardEntity).mockImplementation(async () => {
      vi.mocked(getEntities).mockRejectedValue(new Error('HTTP 503'));
      return NEW_SUP as never;
    });
    vi.mocked(createExpense).mockResolvedValue({ id: 31 } as never);
    mount(<NewExpenseSheet open onOpenChange={() => undefined} />);
    await fillExpense();
    await screen.findByRole('button', { name: /Neste Eesti/ });
    openNew('supplier', 'Uus Tarnija');
    await fillNew();
    fireEvent.click(addBtn());
    expect(
      await screen.findByText(/Couldn't refresh suppliers/),
    ).toBeInTheDocument();
    const picked = screen.getByRole('group', { name: 'Supplier' });
    expect(picked).toHaveTextContent('Uus Tarnija · EE · #42');
    expect(picked).not.toHaveTextContent('not available');
    expect(createExpenseBtn()).toBeEnabled();
    fireEvent.click(createExpenseBtn());
    await waitFor(() =>
      expect(createExpense).toHaveBeenCalledWith(
        expect.objectContaining({ supplier_id: 42 }),
      ),
    );
    expect(onboardEntity).toHaveBeenCalledTimes(1);
  });

  it('with the supplier list failed from the start, a deliberate add is allowed and answers the question', async () => {
    vi.mocked(getEntities).mockRejectedValue(new Error('HTTP 503'));
    vi.mocked(onboardEntity).mockResolvedValue(NEW_SUP as never);
    mount(<NewExpenseSheet open onOpenChange={() => undefined} />);
    await fillExpense();
    expect(
      await screen.findByText(/Couldn't load suppliers \(HTTP 503\)/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/an existing supplier may not be shown/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/No matches/)).toBeNull();
    expect(createExpenseBtn()).toBeDisabled();
    openNew('supplier', 'Uus Tarnija');
    await fillNew();
    fireEvent.click(addBtn());
    await waitFor(() =>
      expect(screen.getByRole('group', { name: 'Supplier' })).toHaveTextContent(
        '#42',
      ),
    );
    // The failed list is still stated, but the created entity is the answer.
    expect(screen.getByText(/Couldn't load suppliers/)).toBeInTheDocument();
    expect(createExpenseBtn()).toBeEnabled();
    expectExpenseKept();
  });

  it('a refused add keeps every input, says it was not confirmed, and is not replayed — a retry is one more explicit call', async () => {
    vi.mocked(getEntities).mockResolvedValue([SUP] as never);
    vi.mocked(onboardEntity).mockRejectedValueOnce(new Error('HTTP 400'));
    mount(<NewExpenseSheet open onOpenChange={() => undefined} />);
    await fillExpense();
    await screen.findByRole('button', { name: /Neste Eesti/ });
    openNew('supplier', 'Uus Tarnija');
    await fillNew();
    fireEvent.click(addBtn());
    expect(
      await screen.findByText(
        /Adding the supplier was not confirmed \(HTTP 400\)/,
      ),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveValue('Uus Tarnija');
    expect(screen.getByLabelText('Registration key')).toHaveValue(
      'EE100200300',
    );
    expectExpenseKept();
    expect(createExpenseBtn()).toBeDisabled();
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(onboardEntity).toHaveBeenCalledTimes(1);

    vi.mocked(onboardEntity).mockResolvedValueOnce(NEW_SUP as never);
    fireEvent.click(addBtn());
    await waitFor(() =>
      expect(screen.getByRole('group', { name: 'Supplier' })).toHaveTextContent(
        '#42',
      ),
    );
    expect(onboardEntity).toHaveBeenCalledTimes(2);
  });

  it('single flight: a same-tick double call sends one add, and the draft cannot be created while it is in flight', async () => {
    vi.mocked(getEntities).mockResolvedValue([SUP] as never);
    const pending = deferred<unknown>();
    vi.mocked(onboardEntity).mockReturnValue(pending.promise as never);
    mount(<NewExpenseSheet open onOpenChange={() => undefined} />);
    await fillExpense();
    await screen.findByRole('button', { name: /Neste Eesti/ });
    openNew('supplier', 'Uus Tarnija');
    await fillNew();
    const add = submitFormOf(addBtn());
    act(() => {
      add();
      add();
    });
    expect(onboardEntity).toHaveBeenCalledTimes(1);
    // The whole sheet is locked (fieldset) and the draft submit is a no-op
    // even when its form is submitted programmatically.
    expect(screen.getByLabelText('Gross (€)')).toBeDisabled();
    const submit = submitFormOf(createExpenseBtn());
    act(() => submit());
    expect(createExpense).not.toHaveBeenCalled();
    await act(async () => pending.resolve(NEW_SUP));
    await waitFor(() =>
      expect(screen.getByRole('group', { name: 'Supplier' })).toHaveTextContent(
        '#42',
      ),
    );
    expect(onboardEntity).toHaveBeenCalledTimes(1);
    expect(createExpense).not.toHaveBeenCalled();
  });

  it('a late answer after the session changed is dropped whole: no pick, no receipt', async () => {
    vi.mocked(getEntities).mockResolvedValue([SUP] as never);
    const pending = deferred<unknown>();
    vi.mocked(onboardEntity).mockReturnValue(pending.promise as never);
    mount(<NewExpenseSheet open onOpenChange={() => undefined} />);
    await fillExpense();
    await screen.findByRole('button', { name: /Neste Eesti/ });
    openNew('supplier', 'Uus Tarnija');
    await fillNew();
    fireEvent.click(addBtn());
    setToken('session-b');
    await act(async () => pending.resolve(NEW_SUP));
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(screen.queryByRole('group', { name: 'Supplier' })).toBeNull();
    expect(screen.getByLabelText('Name')).toHaveValue('Uus Tarnija');
    expect(sessionStorage.getItem('bk_operation_results') ?? '').not.toContain(
      'Uus Tarnija',
    );
  });

  it('a list fetch started before the add, landing after it, does not mark the new supplier gone', async () => {
    vi.mocked(getEntities).mockResolvedValue([SUP] as never);
    const { qc } = mount(
      <NewExpenseSheet open onOpenChange={() => undefined} />,
    );
    await fillExpense();
    await screen.findByRole('button', { name: /Neste Eesti/ });
    // A refetch in flight that predates the creation.
    const old = deferred<unknown>();
    vi.mocked(getEntities).mockReturnValueOnce(old.promise as never);
    void qc.refetchQueries({ queryKey: sharedKeys.entities });
    vi.mocked(onboardEntity).mockImplementation(async () => {
      vi.mocked(getEntities).mockResolvedValue([SUP, NEW_SUP] as never);
      return NEW_SUP as never;
    });
    openNew('supplier', 'Uus Tarnija');
    await fillNew();
    fireEvent.click(addBtn());
    await waitFor(() =>
      expect(screen.getByRole('group', { name: 'Supplier' })).toHaveTextContent(
        '#42',
      ),
    );
    await act(async () => old.resolve([SUP]));
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(
      screen.getByRole('group', { name: 'Supplier' }),
    ).not.toHaveTextContent('not available');
    expect(createExpenseBtn()).toBeEnabled();
  });

  it('same-named suppliers on file are offered with country and id; "Use" picks it without adding', async () => {
    const TWIN = { ...SUP, id: 8, country: 'FI' };
    vi.mocked(getEntities).mockResolvedValue([SUP, TWIN] as never);
    mount(<NewExpenseSheet open onOpenChange={() => undefined} />);
    await fillExpense();
    await screen.findAllByRole('button', { name: /Neste Eesti/ });
    openNew();
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: '  neste   eesti ' },
    });
    expect(
      screen.getByText(/2 suppliers with this name are already on file/),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', { name: 'Use Neste Eesti · FI · #8' }),
    );
    expect(screen.getByRole('group', { name: 'Supplier' })).toHaveTextContent(
      'Neste Eesti · FI · #8',
    );
    expect(onboardEntity).not.toHaveBeenCalled();
    expect(createExpenseBtn()).toBeEnabled();
  });
});
