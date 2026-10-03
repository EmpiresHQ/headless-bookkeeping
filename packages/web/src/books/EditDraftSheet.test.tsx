import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppToaster } from '../ui/toast';
import { ExpenseScreen } from './ExpenseScreen';
import { InvoiceScreen } from './InvoiceScreen';

vi.mock('../api', async (io) => ({
  ...(await io<typeof import('../api')>()),
  getExpense: vi.fn(),
  getExpenses: vi.fn(),
  getInvoices: vi.fn(),
  getEntities: vi.fn(),
  getDocuments: vi.fn(),
  listApprovals: vi.fn(),
  getCategories: vi.fn(),
  postExpense: vi.fn(),
  postInvoice: vi.fn(),
  updateExpenseDraft: vi.fn(),
  updateInvoiceDraft: vi.fn(),
}));
import {
  getCategories,
  getDocuments,
  getEntities,
  getExpense,
  getExpenses,
  getInvoices,
  listApprovals,
  postExpense,
  updateExpenseDraft,
  updateInvoiceDraft,
  type SalesInvoice,
} from '../api';
import { UnsavedChangesProvider } from '../lib/unsavedChanges';

/** Issue #247: a new or rejected draft is edited in place and resubmitted. */

const EXPENSE = {
  id: 12,
  document_id: 9,
  supplier_id: 3,
  category: 'rent',
  gross_amount: 12345,
  vat_amount: 2227,
  currency: 'EUR',
  tax_point_date: '2026-06-25',
  status: 'draft',
  supplier_invoice_number: 'A-183',
  ai_confidence: 0.96,
  claimant_id: null,
  company_addressed_receipt: null,
  created_at: 1750830000,
};

const ENTITIES = [
  {
    id: 3,
    role: 'supplier',
    country: 'EE',
    name: 'AS Merko Ehitus',
    goods_vs_services: null,
    tax_status: null,
  },
  {
    id: 4,
    role: 'supplier',
    country: 'EE',
    name: 'Telia Eesti AS',
    goods_vs_services: null,
    tax_status: null,
  },
  {
    id: 7,
    role: 'customer',
    country: 'EE',
    name: 'Nordic Consulting OÜ',
    goods_vs_services: null,
    tax_status: null,
  },
  {
    id: 8,
    role: 'customer',
    country: 'FI',
    name: 'Helsinki Oy',
    goods_vs_services: null,
    tax_status: null,
  },
];

const REJECTION = {
  id: 4,
  object_type: 'expense',
  object_id: 12,
  status: 'rejected',
  rejected_reason: 'Wrong category',
  resolved_at: 1750900000,
};

const CATEGORIES = [
  { key: 'rent', label: 'Rent', accountCode: '5100' },
  { key: 'software', label: 'Software', accountCode: '5200' },
];

function mountExpense(detail: Partial<typeof EXPENSE> = {}) {
  vi.mocked(getExpense).mockResolvedValue({ ...EXPENSE, ...detail } as never);
  vi.mocked(getExpenses).mockResolvedValue([] as never);
  vi.mocked(getDocuments).mockResolvedValue([
    { id: 9, expense_id: 12, filename: 'arve-183.pdf' },
  ] as never);
  vi.mocked(listApprovals).mockResolvedValue([REJECTION] as never);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <UnsavedChangesProvider onUnauthorized={() => undefined}>
        <MemoryRouter initialEntries={['/books/expenses/12']}>
          <AppToaster />
          <Routes>
            <Route path="/books/expenses/:id" element={<ExpenseScreen />} />
            <Route path="/books" element={<div>BOOKS LIST</div>} />
          </Routes>
        </MemoryRouter>
      </UnsavedChangesProvider>
    </QueryClientProvider>,
  );
}

const INVOICE: SalesInvoice = {
  supply_type: null,
  service_place_rule: 'general',
  id: 3,
  customer_id: 7,
  invoice_number: '2026-018',
  gross_amount: 120001,
  vat_amount: 21639,
  currency: 'EUR',
  tax_point_date: '2026-07-04',
  due_date: '2026-07-18',
  document_id: 5,
  status: 'draft',
  sent_at: null,
  reconciled: false,
};

function mountInvoice(inv: Partial<SalesInvoice> = {}) {
  vi.mocked(getInvoices).mockResolvedValue([{ ...INVOICE, ...inv }] as never);
  vi.mocked(listApprovals).mockResolvedValue([
    { ...REJECTION, object_type: 'sales_invoice', object_id: 3 },
  ] as never);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <UnsavedChangesProvider onUnauthorized={() => undefined}>
        <MemoryRouter initialEntries={['/books/invoices/3']}>
          <AppToaster />
          <Routes>
            <Route path="/books/invoices/:id" element={<InvoiceScreen />} />
          </Routes>
        </MemoryRouter>
      </UnsavedChangesProvider>
    </QueryClientProvider>,
  );
}

async function openEditor() {
  fireEvent.click(await screen.findByRole('button', { name: 'Edit draft…' }));
  return screen.findByRole('dialog');
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  // Reset (not just clear): a previous test's queued Once-values or a
  // never-settling promise must not leak into the next one.
  vi.resetAllMocks();
  vi.mocked(getEntities).mockResolvedValue(ENTITIES as never);
  vi.mocked(getCategories).mockResolvedValue(CATEGORIES as never);
});

describe('Edit draft expense (issue #247)', () => {
  it('prefills exact cents, saves the SAME draft with the full fact set, keeps rejection + source, then resubmits', async () => {
    vi.mocked(updateExpenseDraft).mockResolvedValue({
      ...EXPENSE,
      category: 'software',
    } as never);
    vi.mocked(postExpense).mockResolvedValue({
      expense: { id: 12, status: 'posted' },
      policy: { action: 'auto-post', reason: 'ok' },
    } as never);
    mountExpense();
    expect(await screen.findByText(/Rejected — Wrong category/)).toBeVisible();

    await openEditor();
    expect(screen.getByLabelText(/^Gross/)).toHaveValue('123.45');
    expect(screen.getByLabelText(/^VAT/)).toHaveValue('22.27');
    expect(screen.getByLabelText('Currency')).toHaveValue('EUR');
    expect(screen.getByLabelText('Tax point date')).toHaveValue('2026-06-25');
    await waitFor(() =>
      expect(screen.getByLabelText('Supplier')).toHaveValue('3'),
    );

    fireEvent.change(screen.getByLabelText('Category'), {
      target: { value: 'software' },
    });
    fireEvent.change(screen.getByLabelText('Supplier'), {
      target: { value: '4' },
    });
    const gross = screen.getByLabelText(/^Gross/);
    fireEvent.change(gross, { target: { value: '99,99' } });
    const vat = screen.getByLabelText(/^VAT/);
    fireEvent.change(vat, { target: { value: '18.03' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));

    await waitFor(() =>
      expect(updateExpenseDraft).toHaveBeenCalledWith(12, {
        category: 'software',
        supplier_id: 4,
        gross_amount: 9999,
        vat_amount: 1803,
        currency: 'EUR',
        tax_point_date: '2026-06-25',
        supplier_invoice_number: 'A-183',
        claimant_id: null,
        company_addressed_receipt: null,
      }),
    );
    expect(updateExpenseDraft).toHaveBeenCalledTimes(1);
    // Saving never posts.
    expect(postExpense).not.toHaveBeenCalled();
    expect(await screen.findByText(/Draft saved/)).toBeVisible();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    // Context survives: rejection notice and source document are still there.
    expect(screen.getByText(/Rejected — Wrong category/)).toBeVisible();
    expect(screen.getByRole('link', { name: /arve-183\.pdf/ })).toBeVisible();

    // Resubmission stays a deliberate, separate act.
    fireEvent.click(screen.getByRole('button', { name: 'Submit for posting' }));
    await waitFor(() => expect(postExpense).toHaveBeenCalledWith(12));
  });

  it('a failed save keeps every typed value, shows the reason inline, and a retry succeeds', async () => {
    vi.mocked(updateExpenseDraft)
      .mockRejectedValueOnce(
        new Error('409 Conflict: Cannot update draft: expense 12 is posted'),
      )
      .mockResolvedValueOnce(EXPENSE as never);
    mountExpense();
    await openEditor();
    const gross = screen.getByLabelText(/^Gross/);
    fireEvent.change(gross, { target: { value: '50.00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/expense 12 is posted/);
    expect(alert).toHaveTextContent(/Your changes are kept/);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByLabelText(/^Gross/)).toHaveValue('50.00');

    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(updateExpenseDraft).toHaveBeenCalledTimes(2));
    expect(vi.mocked(updateExpenseDraft).mock.calls[1][1]).toMatchObject({
      gross_amount: 5000,
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('while a save is in flight: one write only, and the sheet refuses to close', async () => {
    const pending = deferred<never>();
    vi.mocked(updateExpenseDraft).mockReturnValue(pending.promise);
    mountExpense();
    await openEditor();
    const save = screen.getByRole('button', { name: 'Save draft' });
    fireEvent.click(save);
    fireEvent.click(save);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(updateExpenseDraft).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByLabelText(/^Gross/)).toBeDisabled();
    pending.reject(new Error('500 Internal Server Error: boom'));
    expect(await screen.findByRole('alert')).toHaveTextContent('boom');
    expect(screen.getByLabelText(/^Gross/)).not.toBeDisabled();
  });

  it('blocks invalid amounts/dates client-side (VAT above gross, bad currency)', async () => {
    mountExpense();
    await openEditor();
    const vat = screen.getByLabelText(/^VAT/);
    fireEvent.change(vat, { target: { value: '200' } });
    expect(screen.getByText('VAT cannot exceed the gross')).toBeVisible();
    const cur = screen.getByLabelText('Currency');
    fireEvent.change(cur, { target: { value: 'E1' } });
    expect(screen.getByText(/3-letter code/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Save draft' })).toBeDisabled();
  });

  it('a failed entity lookup is visible and the current supplier is kept', async () => {
    vi.mocked(getEntities).mockRejectedValue(new Error('503 Unavailable'));
    vi.mocked(updateExpenseDraft).mockResolvedValue(EXPENSE as never);
    mountExpense();
    await openEditor();
    expect(
      await screen.findByText(/Couldn't load suppliers \(503 Unavailable\)/),
    ).toBeVisible();
    expect(screen.getByLabelText('Supplier')).toHaveValue('3');
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() =>
      expect(vi.mocked(updateExpenseDraft).mock.calls[0][1]).toMatchObject({
        supplier_id: 3,
      }),
    );
  });

  it('a duplicate refusal needs a deliberate "save anyway" before allow_duplicate is sent', async () => {
    vi.mocked(updateExpenseDraft)
      .mockRejectedValueOnce(
        new Error(
          '409 Conflict: possible duplicate of expense #5: same supplier and invoice number A-1.',
        ),
      )
      .mockResolvedValueOnce(EXPENSE as never);
    mountExpense();
    await openEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /possible duplicate of expense #5/,
    );
    const save = screen.getByRole('button', { name: 'Save draft' });
    expect(save).toBeDisabled();
    fireEvent.click(screen.getByLabelText(/separate purchase/));
    fireEvent.click(save);
    await waitFor(() => expect(updateExpenseDraft).toHaveBeenCalledTimes(2));
    expect(vi.mocked(updateExpenseDraft).mock.calls[0][1]).not.toHaveProperty(
      'allow_duplicate',
    );
    expect(vi.mocked(updateExpenseDraft).mock.calls[1][1]).toMatchObject({
      allow_duplicate: true,
    });
  });

  it('after a duplicate refusal, fixing the colliding reference saves normally WITHOUT an override', async () => {
    vi.mocked(updateExpenseDraft)
      .mockRejectedValueOnce(
        new Error(
          '409 Conflict: possible duplicate of expense #5: same supplier and invoice number A-1.',
        ),
      )
      .mockResolvedValueOnce(EXPENSE as never);
    mountExpense();
    await openEditor();
    fireEvent.change(screen.getByLabelText('Supplier invoice no.'), {
      target: { value: 'A-1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /possible duplicate/,
    );
    expect(screen.getByRole('button', { name: 'Save draft' })).toBeDisabled();

    // The operator realises the reference was mistyped and fixes it: the
    // refusal no longer applies and the override prompt disappears.
    fireEvent.change(screen.getByLabelText('Supplier invoice no.'), {
      target: { value: 'A-2' },
    });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByLabelText(/separate purchase/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(updateExpenseDraft).toHaveBeenCalledTimes(2));
    const retry = vi.mocked(updateExpenseDraft).mock.calls[1][1];
    expect(retry).toMatchObject({ supplier_invoice_number: 'A-2' });
    expect(retry).not.toHaveProperty('allow_duplicate');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('override consent is bound to the refused values and never carries over to a different collision', async () => {
    const dup = (n: number) =>
      new Error(
        `409 Conflict: possible duplicate of expense #${n}: same supplier and invoice number.`,
      );
    vi.mocked(updateExpenseDraft)
      .mockRejectedValueOnce(dup(5))
      .mockRejectedValueOnce(dup(6))
      .mockResolvedValueOnce(EXPENSE as never);
    mountExpense();
    await openEditor();
    const ref = () => screen.getByLabelText('Supplier invoice no.');
    fireEvent.change(ref(), { target: { value: 'A-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    fireEvent.click(await screen.findByLabelText(/separate purchase/));
    expect(screen.getByLabelText(/separate purchase/)).toBeChecked();

    // Consent given for A-1 — then the values change to B-7.
    fireEvent.change(ref(), { target: { value: 'B-7' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(updateExpenseDraft).toHaveBeenCalledTimes(2));
    expect(vi.mocked(updateExpenseDraft).mock.calls[1][1]).not.toHaveProperty(
      'allow_duplicate',
    );
    // B-7 collides with a different purchase: a fresh, unchecked decision.
    expect(await screen.findByRole('alert')).toHaveTextContent(/expense #6/);
    expect(screen.getByLabelText(/separate purchase/)).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Save draft' })).toBeDisabled();

    // Returning to A-1 does not resurrect the old consent either.
    fireEvent.change(ref(), { target: { value: 'A-1' } });
    expect(screen.queryByLabelText(/separate purchase/)).toBeNull();

    fireEvent.change(ref(), { target: { value: 'B-7' } });
    fireEvent.click(screen.getByLabelText(/separate purchase/));
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(updateExpenseDraft).toHaveBeenCalledTimes(3));
    expect(vi.mocked(updateExpenseDraft).mock.calls[2][1]).toMatchObject({
      supplier_invoice_number: 'B-7',
      allow_duplicate: true,
    });
  });

  it('posted, pending and reversed expenses offer no draft edit', async () => {
    for (const status of ['posted', 'pending', 'reversed']) {
      mountExpense({ status });
      await screen.findAllByText(/Expense/);
      await waitFor(() =>
        expect(
          screen.queryByRole('button', { name: 'Edit draft…' }),
        ).toBeNull(),
      );
      cleanup();
    }
  });
});

describe('Edit draft invoice (issue #247)', () => {
  it('an unsent draft edits identity and facts; saving keeps rejection and source', async () => {
    vi.mocked(updateInvoiceDraft).mockResolvedValue(INVOICE as never);
    mountInvoice();
    expect(await screen.findByText(/Rejected — Wrong category/)).toBeVisible();
    await openEditor();
    expect(screen.getByLabelText(/^Gross/)).toHaveValue('1200.01');
    const number = screen.getByLabelText('Invoice number');
    expect(number).toHaveValue('2026-018');
    fireEvent.change(number, { target: { value: '2026-019' } });
    await waitFor(() =>
      expect(screen.getByLabelText('Customer')).toHaveValue('7'),
    );
    fireEvent.change(screen.getByLabelText('Customer'), {
      target: { value: '8' },
    });
    fireEvent.change(screen.getByLabelText('Supply type'), {
      target: { value: 'services' },
    });
    fireEvent.change(screen.getByLabelText('Due date'), {
      target: { value: '' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() =>
      expect(updateInvoiceDraft).toHaveBeenCalledWith(3, {
        invoice_number: '2026-019',
        customer_id: 8,
        gross_amount: 120001,
        vat_amount: 21639,
        currency: 'EUR',
        tax_point_date: '2026-07-04',
        due_date: null,
        supply_type: 'services',
        service_place_rule: 'general',
      }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByText(/Rejected — Wrong category/)).toBeVisible();
    expect(screen.getByRole('link', { name: /Source document/ })).toBeVisible();
  });

  it('a SENT draft shows identity as locked and never sends it', async () => {
    vi.mocked(updateInvoiceDraft).mockResolvedValue(INVOICE as never);
    mountInvoice({ sent_at: 1751600000 });
    await openEditor();
    expect(screen.getByLabelText('Invoice number')).toBeDisabled();
    expect(screen.getByLabelText('Customer')).toBeDisabled();
    expect(
      screen.getAllByText('Locked — already sent to the customer'),
    ).toHaveLength(2);
    const vat = screen.getByLabelText(/^VAT/);
    fireEvent.change(vat, { target: { value: '200.00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(updateInvoiceDraft).toHaveBeenCalled());
    const payload = vi.mocked(updateInvoiceDraft).mock.calls[0][1];
    expect(payload).not.toHaveProperty('invoice_number');
    expect(payload).not.toHaveProperty('customer_id');
    expect(payload).toMatchObject({ vat_amount: 20000 });
  });

  it('a duplicate invoice number keeps the input and explains why', async () => {
    vi.mocked(updateInvoiceDraft).mockRejectedValue(
      new Error('409 Conflict: Invoice number 2026-001 already exists'),
    );
    mountInvoice();
    await openEditor();
    const number = screen.getByLabelText('Invoice number');
    fireEvent.change(number, { target: { value: '2026-001' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /2026-001 already exists/,
    );
    expect(screen.getByLabelText('Invoice number')).toHaveValue('2026-001');
  });

  it('a posted invoice keeps the separate Correct… flow and no draft edit', async () => {
    mountInvoice({ status: 'posted' });
    expect(
      await screen.findByRole('button', { name: 'Correct…' }),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Edit draft…' })).toBeNull();
  });
});
