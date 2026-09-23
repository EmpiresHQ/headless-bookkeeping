import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppToaster } from '../ui/toast';
import { NewExpenseSheet, NewInvoiceSheet } from './create';

vi.mock('../api', async (io) => ({
  ...(await io<typeof import('../api')>()),
  createExpense: vi.fn(),
  createInvoice: vi.fn(),
  getCategories: vi.fn(),
  getEntities: vi.fn(),
  onboardEntity: vi.fn(),
}));
import {
  createExpense,
  createInvoice,
  getCategories,
  getEntities,
  onboardEntity,
} from '../api';
import { HttpError, setToken } from '../auth';
import { UnsavedChangesProvider } from '../lib/unsavedChanges';

/**
 * Issue #265 — field-level validation and server feedback on the manual
 * Books forms: nothing red before interaction, a click on submit explains
 * (field error + focus + summary) instead of a dead button, nothing is sent
 * while a field is invalid, the server's structured 400 lands at its field,
 * anything else stays as a persistent, truthful form message, and the input
 * survives every refusal.
 */

function seed() {
  vi.mocked(getCategories).mockResolvedValue([
    { key: 'fuel', label: 'Fuel', accountCode: 'X' },
  ] as never);
  vi.mocked(getEntities).mockResolvedValue([] as never);
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
          </Routes>
        </MemoryRouter>
      </UnsavedChangesProvider>
    </QueryClientProvider>,
  );
}

const refused = (fields: Record<string, string[]>, formErrors: string[] = []) =>
  new HttpError(400, '400 Bad Request: (structured)', { fields, formErrors });

async function openExpense() {
  mount(<NewExpenseSheet open onOpenChange={() => undefined} />);
  await screen.findByText('Fuel');
  // The supplier list settles too (no lookup blocker left).
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: /Create expense/ }),
    ).toBeEnabled(),
  );
}

function fillExpense() {
  fireEvent.change(screen.getByLabelText('Category'), {
    target: { value: 'fuel' },
  });
  fireEvent.change(screen.getByLabelText('Gross (€)'), {
    target: { value: '48.20' },
  });
  fireEvent.change(screen.getByLabelText('Tax point date'), {
    target: { value: '2026-07-01' },
  });
}

const submitBtn = () => screen.getByRole('button', { name: /Create expense/ });

describe('manual Books forms — field validation (#265)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    setToken('tok');
    seed();
  });

  it('shows nothing red before interaction; required is conveyed without red', async () => {
    await openExpense();
    for (const [role, name] of [
      ['combobox', 'Category'],
      ['textbox', 'Gross (€)'],
      ['textbox', 'VAT (€)'],
    ] as const) {
      // Named by the label text alone — the "required" marker is not
      // part of the name.
      const el = screen.getByRole(role, { name });
      expect(el).toHaveAttribute('aria-required', 'true');
      expect(el).not.toHaveAttribute('aria-invalid');
    }
    {
      const el = screen.getByLabelText('Tax point date');
      expect(el).toHaveAttribute('aria-required', 'true');
      expect(el).not.toHaveAttribute('aria-invalid');
    }
    // Leaving a blank required field is not an error yet.
    fireEvent.blur(screen.getByLabelText('Gross (€)'));
    expect(screen.getByLabelText('Gross (€)')).not.toHaveAttribute(
      'aria-invalid',
    );
    expect(screen.queryByText(/Fix \d+ field/)).toBeNull();
  });

  it('a malformed amount is explained after the field is left, and clears once fixed', async () => {
    await openExpense();
    const gross = screen.getByLabelText('Gross (€)');
    fireEvent.change(gross, { target: { value: '12.345' } });
    // Not while typing…
    expect(gross).not.toHaveAttribute('aria-invalid');
    fireEvent.blur(gross);
    // …but once left.
    expect(gross).toHaveAttribute('aria-invalid', 'true');
    expect(gross).toHaveAccessibleDescription(/at most 2 decimals/);
    fireEvent.change(gross, { target: { value: '90071992547409.92' } });
    expect(gross).toHaveAccessibleDescription(/Too large to record exactly/);
    fireEvent.change(gross, { target: { value: '12.34' } });
    expect(gross).not.toHaveAttribute('aria-invalid');
  });

  it('an invalid submit sends nothing, reveals every error, focuses the first and lists them; fixing then sends once', async () => {
    await openExpense();
    fireEvent.change(screen.getByLabelText('Gross (€)'), {
      target: { value: 'abc' },
    });
    fireEvent.click(submitBtn());
    expect(createExpense).not.toHaveBeenCalled();
    const category = screen.getByLabelText('Category');
    await waitFor(() => expect(category).toHaveFocus());
    expect(category).toHaveAccessibleDescription('Choose a category');
    expect(screen.getByLabelText('Gross (€)')).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    expect(screen.getByLabelText('Tax point date')).toHaveAccessibleDescription(
      'Pick the tax point date',
    );
    expect(screen.getByText('Fix 3 fields to continue:')).toBeInTheDocument();
    // A summary row focuses its field.
    fireEvent.click(screen.getByRole('button', { name: /^Tax point date — / }));
    expect(screen.getByLabelText('Tax point date')).toHaveFocus();
    // The summary follows the current errors — a fixed field leaves it.
    fireEvent.change(screen.getByLabelText('Category'), {
      target: { value: 'fuel' },
    });
    expect(screen.getByText('Fix 2 fields to continue:')).toBeInTheDocument();
    fillExpense();
    expect(screen.queryByText(/Fix \d+ field/)).toBeNull();
    vi.mocked(createExpense).mockResolvedValue({ id: 31 } as never);
    fireEvent.click(submitBtn());
    await waitFor(() => expect(createExpense).toHaveBeenCalledTimes(1));
    expect(createExpense).toHaveBeenCalledWith(
      expect.objectContaining({ gross_amount: 4820, vat_amount: 869 }),
    );
  });

  it('a VAT the operator cleared is not replaced by the auto amount: hinted, then an error on submit', async () => {
    await openExpense();
    fillExpense();
    const vat = screen.getByLabelText('VAT (€)');
    expect(vat).toHaveValue('8.69');
    expect(vat).toHaveAccessibleDescription(/Auto at 22%/);
    fireEvent.change(vat, { target: { value: '' } });
    expect(vat).toHaveAccessibleDescription(
      'Required — enter 0.00 if there is no VAT',
    );
    expect(vat).not.toHaveAttribute('aria-invalid');
    fireEvent.click(submitBtn());
    expect(createExpense).not.toHaveBeenCalled();
    expect(vat).toHaveAccessibleDescription(
      'Enter the VAT — 0.00 if there is none',
    );
    await waitFor(() => expect(vat).toHaveFocus());
  });

  it("the server's structured 400 lands at its field (after the lock releases), keeps the input, and clears when that field changes; unknown keys stay as messages", async () => {
    let reject!: (e: unknown) => void;
    vi.mocked(createExpense).mockReturnValue(
      new Promise((_, rej) => (reject = rej)) as never,
    );
    await openExpense();
    fillExpense();
    fireEvent.click(submitBtn());
    await waitFor(() =>
      expect(screen.getByLabelText('Gross (€)')).toBeDisabled(),
    );
    await act(async () =>
      reject(
        refused(
          {
            gross_amount: ['must be greater than zero'],
            constructor: ['odd key'],
          },
          ['Invalid input'],
        ),
      ),
    );
    const gross = screen.getByLabelText('Gross (€)');
    await waitFor(() => expect(gross).not.toBeDisabled());
    expect(gross).toHaveValue('48.20');
    expect(gross).toHaveAttribute('aria-invalid', 'true');
    expect(gross).toHaveAccessibleDescription('must be greater than zero');
    // Focus waited for the pending fieldset to release.
    await waitFor(() => expect(gross).toHaveFocus());
    const alert = screen
      .getByText(/Not created — the server refused this draft expense/)
      .closest('[role="alert"]') as HTMLElement;
    expect(within(alert).getByText('constructor: odd key')).toBeInTheDocument();
    expect(within(alert).getByText('Invalid input')).toBeInTheDocument();
    // The other fields are untouched by the server's answer.
    expect(screen.getByLabelText('Tax point date')).not.toHaveAttribute(
      'aria-invalid',
    );
    // Editing the named field retires its server error.
    fireEvent.change(gross, { target: { value: '48.21' } });
    expect(gross).not.toHaveAttribute('aria-invalid');
  });

  it('a free-text refusal (duplicate number) names no field — a persistent summary, input kept', async () => {
    vi.mocked(createInvoice).mockRejectedValue(
      new HttpError(
        409,
        '409 Conflict: Invoice number 2026-020 already exists',
      ),
    );
    mount(<NewInvoiceSheet open onOpenChange={() => undefined} />);
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /Create invoice/ }),
      ).toBeEnabled(),
    );
    fireEvent.change(screen.getByLabelText('Invoice number'), {
      target: { value: '2026-020' },
    });
    fireEvent.change(screen.getByLabelText('Gross (€)'), {
      target: { value: '500' },
    });
    fireEvent.change(screen.getByLabelText('Tax point date'), {
      target: { value: '2026-07-05' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Create invoice/ }));
    const heading = await screen.findByText(
      'Not created — the server refused this draft invoice. Your input is kept.',
    );
    const alert = heading.closest('[role="alert"]') as HTMLElement;
    expect(alert).toHaveTextContent(/Invoice number 2026-020 already exists/);
    expect(screen.getByLabelText('Invoice number')).toHaveValue('2026-020');
    // Never guessed from the text.
    expect(screen.getByLabelText('Invoice number')).not.toHaveAttribute(
      'aria-invalid',
    );
    await waitFor(() => expect(alert.parentElement).toHaveFocus());
  });

  it('a refusal that lands after the session changed is dropped: no form message, no focus move', async () => {
    let reject!: (e: unknown) => void;
    vi.mocked(createExpense).mockReturnValue(
      new Promise((_, rej) => (reject = rej)) as never,
    );
    await openExpense();
    fillExpense();
    fireEvent.click(submitBtn());
    await waitFor(() =>
      expect(screen.getByLabelText('Gross (€)')).toBeDisabled(),
    );
    act(() => setToken('someone-else'));
    await act(async () =>
      reject(refused({ gross_amount: ['must be greater than zero'] })),
    );
    await act(async () => new Promise((r) => setTimeout(r, 0)));
    expect(screen.queryByText(/Not saved/)).toBeNull();
    expect(screen.getByLabelText('Gross (€)')).not.toHaveAttribute(
      'aria-invalid',
    );
    expect(screen.getByLabelText('Gross (€)')).not.toHaveFocus();
  });

  it('a structural blocker never hides what else needs fixing', async () => {
    // The category list never loads: the submit is blocked by it…
    vi.mocked(getCategories).mockReturnValue(new Promise(() => undefined));
    mount(<NewExpenseSheet open onOpenChange={() => undefined} />);
    expect(
      await screen.findByText('Waiting for categories to load.'),
    ).toBeInTheDocument();
    expect(submitBtn()).toBeDisabled();
    // …and the fields still to fill are listed with it, muted, as links.
    const still = screen.getByText(/Also still needed:/);
    expect(still).toHaveTextContent('Category, Gross (€), Tax point date');
    fireEvent.click(within(still).getByRole('button', { name: 'Gross (€)' }));
    expect(screen.getByLabelText('Gross (€)')).toHaveFocus();
  });

  it('the inline new-supplier form explains a missing registration key instead of a dead Add button', async () => {
    await openExpense();
    fireEvent.click(screen.getByRole('button', { name: 'New supplier…' }));
    const group = screen.getByRole('group', { name: 'New supplier' });
    fireEvent.change(within(group).getByLabelText('Name'), {
      target: { value: 'Citybee' },
    });
    fireEvent.change(within(group).getByLabelText('Country'), {
      target: { value: 'EE' },
    });
    fireEvent.click(
      within(group).getByRole('button', { name: 'Add supplier' }),
    );
    expect(onboardEntity).not.toHaveBeenCalled();
    const regKey = within(group).getByLabelText('Registration key');
    expect(regKey).toHaveAttribute('aria-invalid', 'true');
    await waitFor(() => expect(regKey).toHaveFocus());
    // The sheet's submit still names the unfinished add as its blocker.
    expect(
      screen.getByText(
        'Finish adding the new supplier, or discard it to continue without one.',
      ),
    ).toBeInTheDocument();
  });

  it("an onboard 400 lands at the counterparty's own field", async () => {
    vi.mocked(onboardEntity).mockRejectedValue(
      refused({ registrationKey: ['must not be blank'] }),
    );
    await openExpense();
    fireEvent.click(screen.getByRole('button', { name: 'New supplier…' }));
    const group = screen.getByRole('group', { name: 'New supplier' });
    fireEvent.change(within(group).getByLabelText('Name'), {
      target: { value: 'Citybee' },
    });
    fireEvent.change(within(group).getByLabelText('Country'), {
      target: { value: 'EE' },
    });
    fireEvent.change(within(group).getByLabelText('Registration key'), {
      target: { value: 'x' },
    });
    fireEvent.click(
      within(group).getByRole('button', { name: 'Add supplier' }),
    );
    const regKey = within(group).getByLabelText('Registration key');
    await waitFor(() =>
      expect(regKey).toHaveAccessibleDescription('must not be blank'),
    );
    expect(regKey).toHaveValue('x');
    fireEvent.change(regKey, { target: { value: 'x2' } });
    expect(regKey).not.toHaveAttribute('aria-invalid');
  });

  it('a server supplier_id error lands at the counterparty search (aria-invalid + description) and focuses it', async () => {
    vi.mocked(createExpense).mockRejectedValue(
      refused({ supplier_id: ['Expected number, received string'] }),
    );
    await openExpense();
    fillExpense();
    fireEvent.click(submitBtn());
    const search = await screen.findByPlaceholderText('Search suppliers…');
    await waitFor(() => expect(search).toHaveAttribute('aria-invalid', 'true'));
    expect(search).toHaveAccessibleDescription(
      /Expected number, received string/,
    );
    await waitFor(() => expect(search).toHaveFocus());
  });
});
