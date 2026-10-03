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

/**
 * Issue #266 — the manual Books forms submit natively: Enter in a field,
 * the button and `requestSubmit()` share ONE path with the same guards
 * (blocker, #265 field errors, the #251 single-flight lock). The inline
 * new-counterparty controls belong to their own (never nested) form: Enter
 * there adds the counterparty, never the draft; Enter in the counterparty
 * search submits nothing.
 */

const CATS = [{ key: 'fuel', label: 'Fuel', accountCode: 'X' }];
const SUP = { id: 5, role: 'supplier', name: 'Neste Eesti', country: 'EE' };
const NEW_SUP = {
  id: 42,
  role: 'supplier',
  name: 'Uus Tarnija',
  country: 'EE',
};

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function mount(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
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
}

/** The form's default button, as the browser picks it for implicit
 *  submission: the first submit button whose form OWNER is this form
 *  (`form.elements` honours the `form` attribute; a DOM query would not). */
function defaultButton(form: HTMLFormElement) {
  return Array.from(form.elements).find(
    (e): e is HTMLButtonElement =>
      e instanceof HTMLButtonElement && e.type === 'submit',
  );
}

/** Enter in a field, the way a browser treats it: a cancelled keydown
 *  submits nothing; otherwise the form owner's default button is activated
 *  — unless it is disabled. A composing Enter is NOT exempted here: an
 *  automated Chromium composition (CDP) was seen to submit on it, so only
 *  the form's own guard may stop it. (user-event's Enter looks the button
 *  up by DOM descent, which misses `form`-attribute owners.) */
function pressEnter(el: HTMLElement, init: KeyboardEventInit = {}) {
  const proceed = fireEvent.keyDown(el, {
    key: 'Enter',
    code: 'Enter',
    keyCode: 13,
    ...init,
  });
  if (!proceed) return;
  const form = (el as HTMLInputElement).form;
  const button = form === null ? undefined : defaultButton(form);
  if (button !== undefined && !button.matches(':disabled')) {
    fireEvent.click(button);
  }
}

const gross = () => screen.getByLabelText('Gross (€)');
const createExpenseBtn = () =>
  screen.getByRole('button', { name: /Create expense/ });
const createInvoiceBtn = () =>
  screen.getByRole('button', { name: /Create invoice/ });
const formOf = (el: HTMLElement) => {
  const f = (el as HTMLInputElement).form;
  if (f === null) throw new Error('no form owner');
  return f;
};

async function openExpense() {
  mount(<NewExpenseSheet open onOpenChange={() => undefined} />);
  await screen.findByRole('option', { name: 'Fuel' });
  await screen.findByRole('button', { name: /Neste Eesti/ });
}

function fillExpense() {
  fireEvent.change(screen.getByLabelText('Category'), {
    target: { value: 'fuel' },
  });
  fireEvent.change(gross(), { target: { value: '48,20' } });
  fireEvent.change(screen.getByLabelText('Tax point date'), {
    target: { value: '2026-07-01' },
  });
}

function expectExpenseKept() {
  expect(screen.getByLabelText('Category')).toHaveValue('fuel');
  expect(gross()).toHaveValue('48,20');
  expect(screen.getByLabelText('Tax point date')).toHaveValue('2026-07-01');
}

async function openNewSupplier() {
  fireEvent.change(screen.getByLabelText('Supplier'), {
    target: { value: 'Uus Tarnija' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'New supplier…' }));
  await waitFor(() =>
    expect(screen.getByLabelText('Country')).toHaveValue('EE'),
  );
}

describe('manual create forms — native submit (#266)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    sessionStorage.clear();
    setToken('session-a');
    vi.mocked(getCategories).mockResolvedValue(CATS as never);
    vi.mocked(getEntities).mockResolvedValue([SUP] as never);
    vi.mocked(getOrganization).mockResolvedValue({ country: 'EE' } as never);
  });

  it('one real form per sheet: noValidate, Create is its default button, every other button is type=button', async () => {
    await openExpense();
    const form = formOf(gross());
    expect(document.querySelectorAll('form')).toHaveLength(1);
    expect(form.noValidate).toBe(true);
    expect(defaultButton(form)).toBe(createExpenseBtn());
    const submits = Array.from(form.elements).filter(
      (e) => e instanceof HTMLButtonElement && e.type === 'submit',
    );
    expect(submits).toEqual([createExpenseBtn()]);
    // The fields are the form's own.
    for (const label of ['Category', 'Supplier', 'Tax point date']) {
      expect(formOf(screen.getByLabelText(label))).toBe(form);
    }
  });

  it('Enter in a filled expense field creates the draft once, as the button would', async () => {
    vi.mocked(createExpense).mockResolvedValue({ id: 31 } as never);
    await openExpense();
    fillExpense();
    pressEnter(gross());
    expect(await screen.findByText('EXP DETAIL')).toBeInTheDocument();
    expect(createExpense).toHaveBeenCalledTimes(1);
    expect(createExpense).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'fuel',
        gross_amount: 4820,
        tax_point_date: '2026-07-01',
        supplier_id: null,
      }),
    );
  });

  it('Enter in a filled invoice field creates the draft once', async () => {
    vi.mocked(createInvoice).mockResolvedValue({ id: 9 } as never);
    mount(<NewInvoiceSheet open onOpenChange={() => undefined} />);
    await waitFor(() => expect(createInvoiceBtn()).toBeEnabled());
    const form = formOf(gross());
    expect(form.noValidate).toBe(true);
    expect(defaultButton(form)).toBe(createInvoiceBtn());
    const number = screen.getByLabelText('Invoice number');
    fireEvent.change(number, { target: { value: 'INV-7' } });
    fireEvent.change(gross(), { target: { value: '100' } });
    fireEvent.change(screen.getByLabelText('Tax point date'), {
      target: { value: '2026-07-02' },
    });
    pressEnter(number);
    expect(await screen.findByText('INV DETAIL')).toBeInTheDocument();
    expect(createInvoice).toHaveBeenCalledTimes(1);
    expect(createInvoice).toHaveBeenCalledWith(
      expect.objectContaining({ invoice_number: 'INV-7', gross_amount: 10000 }),
    );
  });

  it('Enter with invalid fields explains (#265): errors, summary, first field focused — nothing sent', async () => {
    await openExpense();
    fireEvent.change(gross(), { target: { value: '48,20' } });
    pressEnter(gross());
    expect(screen.getByText('Fix 2 fields to continue:')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByLabelText('Category')).toHaveFocus(),
    );
    expect(createExpense).not.toHaveBeenCalled();
    expect(gross()).toHaveValue('48,20');
  });

  it('same-tick repeats (Enter, click, requestSubmit) and a submit while pending send ONE request', async () => {
    const pending = deferred<unknown>();
    vi.mocked(createExpense).mockReturnValue(pending.promise as never);
    await openExpense();
    fillExpense();
    const form = formOf(gross());
    const button = createExpenseBtn();
    act(() => {
      pressEnter(gross());
      pressEnter(gross());
      fireEvent.click(button);
      form.requestSubmit();
    });
    expect(createExpense).toHaveBeenCalledTimes(1);
    // Locked while pending; a programmatic submit ignores that — the guard
    // does not.
    expect(gross()).toBeDisabled();
    expect(button).toBeDisabled();
    act(() => form.requestSubmit());
    expect(createExpense).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve({ id: 31 }));
    expect(await screen.findByText('EXP DETAIL')).toBeInTheDocument();
    expect(createExpense).toHaveBeenCalledTimes(1);
  });

  it('a structural blocker (#260) holds for Enter and requestSubmit alike', async () => {
    vi.mocked(getCategories).mockRejectedValue(new Error('503'));
    mount(<NewExpenseSheet open onOpenChange={() => undefined} />);
    await screen.findByRole('button', { name: /Neste Eesti/ });
    await waitFor(() => expect(createExpenseBtn()).toBeDisabled());
    fireEvent.change(gross(), { target: { value: '48,20' } });
    fireEvent.change(screen.getByLabelText('Tax point date'), {
      target: { value: '2026-07-01' },
    });
    pressEnter(gross());
    act(() => formOf(gross()).requestSubmit());
    expect(createExpense).not.toHaveBeenCalled();
    expect(gross()).toHaveValue('48,20');
  });

  it('Enter in the counterparty search submits nothing, composing or not', async () => {
    await openExpense();
    fillExpense();
    const search = screen.getByLabelText('Supplier');
    fireEvent.change(search, { target: { value: 'Nes' } });
    pressEnter(search);
    pressEnter(search, { isComposing: true });
    pressEnter(search, { keyCode: 229 });
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(createExpense).not.toHaveBeenCalled();
    expect(search).toHaveValue('Nes');
    expectExpenseKept();
  });

  it('an Enter that commits an IME composition never creates the draft; the next plain Enter does', async () => {
    vi.mocked(createExpense).mockResolvedValue({ id: 31 } as never);
    await openExpense();
    fillExpense();
    fireEvent.compositionStart(gross());
    // Chromium (automated composition): isComposing with keyCode 13.
    pressEnter(gross(), { isComposing: true });
    fireEvent.compositionEnd(gross());
    // Safari: compositionend first, then the committing keydown as 229.
    pressEnter(gross(), { keyCode: 229 });
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(createExpense).not.toHaveBeenCalled();
    expect(screen.queryByText(/Fix \d fields? to continue/)).toBeNull();
    // Only the Enter is cancelled — other composing keys are not.
    expect(fireEvent.keyDown(gross(), { key: 'a', isComposing: true })).toBe(
      true,
    );
    pressEnter(gross());
    expect(await screen.findByText('EXP DETAIL')).toBeInTheDocument();
    expect(createExpense).toHaveBeenCalledTimes(1);
  });

  it('inline new supplier: its own form (not nested) — Enter adds the supplier once, never the draft, parent input kept', async () => {
    vi.mocked(onboardEntity).mockImplementation(async () => {
      vi.mocked(getEntities).mockResolvedValue([SUP, NEW_SUP] as never);
      return NEW_SUP as never;
    });
    vi.mocked(createExpense).mockResolvedValue({ id: 31 } as never);
    await openExpense();
    fillExpense();
    await openNewSupplier();
    const parent = formOf(gross());
    const regKey = screen.getByLabelText('Registration key');
    const own = formOf(regKey);
    expect(own).not.toBe(parent);
    expect(parent.contains(own)).toBe(false);
    expect(own.contains(parent)).toBe(false);
    expect(own.noValidate).toBe(true);
    for (const label of [
      'Name',
      'Country',
      'Goods or services',
      'Tax status',
    ]) {
      expect(formOf(screen.getByLabelText(label))).toBe(own);
    }
    const add = screen.getByRole('button', { name: 'Add supplier' });
    expect(defaultButton(own)).toBe(add);
    // Only Create is the sheet's default button; Add is not the sheet's.
    expect(defaultButton(parent)).toBe(createExpenseBtn());

    fireEvent.change(regKey, { target: { value: 'EE100200300' } });
    act(() => {
      pressEnter(regKey);
      pressEnter(screen.getByLabelText('Name'));
    });
    await waitFor(() =>
      expect(screen.getByRole('group', { name: 'Supplier' })).toHaveTextContent(
        '#42',
      ),
    );
    expect(onboardEntity).toHaveBeenCalledTimes(1);
    expect(onboardEntity).toHaveBeenCalledWith(
      expect.objectContaining({
        role: 'supplier',
        name: 'Uus Tarnija',
        country: 'EE',
        registrationKey: 'EE100200300',
      }),
    );
    expect(createExpense).not.toHaveBeenCalled();
    expectExpenseKept();
    // The inner form is gone with the add; Enter now creates the draft.
    expect(document.querySelectorAll('form')).toHaveLength(1);
    pressEnter(gross());
    expect(await screen.findByText('EXP DETAIL')).toBeInTheDocument();
    expect(createExpense).toHaveBeenCalledTimes(1);
    expect(createExpense).toHaveBeenCalledWith(
      expect.objectContaining({ supplier_id: 42 }),
    );
  });

  it('inline new supplier: an incomplete Enter explains at its field and sends nothing', async () => {
    await openExpense();
    fillExpense();
    await openNewSupplier();
    pressEnter(screen.getByLabelText('Name'));
    await waitFor(() =>
      expect(screen.getByLabelText('Registration key')).toHaveFocus(),
    );
    expect(
      screen.getByText('Enter the registration key — a supplier needs one'),
    ).toBeInTheDocument();
    // requestSubmit of the inner form takes the same gate; the sheet's
    // submit stays blocked while the add is unfinished.
    act(() => formOf(screen.getByLabelText('Name')).requestSubmit());
    act(() => formOf(gross()).requestSubmit());
    expect(onboardEntity).not.toHaveBeenCalled();
    expect(createExpense).not.toHaveBeenCalled();
    expectExpenseKept();
  });

  it('inline new supplier: a composing Enter adds nothing; while its add is pending, requestSubmit of either form sends nothing more', async () => {
    const pending = deferred<unknown>();
    vi.mocked(onboardEntity).mockReturnValue(pending.promise as never);
    await openExpense();
    fillExpense();
    await openNewSupplier();
    const regKey = screen.getByLabelText('Registration key');
    fireEvent.change(regKey, { target: { value: 'EE100200300' } });
    pressEnter(regKey, { isComposing: true });
    pressEnter(screen.getByLabelText('Name'), { keyCode: 229 });
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(onboardEntity).not.toHaveBeenCalled();

    pressEnter(regKey);
    expect(onboardEntity).toHaveBeenCalledTimes(1);
    // Rendered pending: locked, and programmatic submits of the inner form
    // and of the sheet's form are both no-ops.
    expect(regKey).toBeDisabled();
    act(() => {
      formOf(regKey).requestSubmit();
      formOf(gross()).requestSubmit();
    });
    expect(onboardEntity).toHaveBeenCalledTimes(1);
    expect(createExpense).not.toHaveBeenCalled();
    await act(async () => pending.resolve(NEW_SUP));
    await waitFor(() =>
      expect(screen.getByRole('group', { name: 'Supplier' })).toHaveTextContent(
        '#42',
      ),
    );
    expect(onboardEntity).toHaveBeenCalledTimes(1);
    expect(createExpense).not.toHaveBeenCalled();
    expectExpenseKept();
  });
});
