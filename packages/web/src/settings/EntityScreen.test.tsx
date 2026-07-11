import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  render,
  screen,
  fireEvent,
  waitFor,
  within,
} from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../api', async (io) => ({
  ...(await io<typeof import('../api')>()),
  getEntity: vi.fn(),
  getExpenses: vi.fn(),
  getInvoices: vi.fn(),
  updateEntity: vi.fn(),
  deleteEntity: vi.fn(),
  addEntityAlias: vi.fn(),
}));
import {
  addEntityAlias,
  deleteEntity,
  getEntity,
  getExpenses,
  getInvoices,
  updateEntity,
  type Entity,
  type Expense,
} from '../api';
import { AppToaster } from '../ui/toast';
import { EntityScreen } from './EntityScreen';

const SUPPLIER: Entity = {
  id: 3,
  role: 'supplier',
  country: 'EE',
  name: 'Circle K Eesti AS',
  goods_vs_services: 'goods',
  identifiers: [
    {
      id: 1,
      entity_id: 3,
      kind: 'registration_key',
      value: 'EE100511246',
      confirmed: true,
    },
    {
      id: 2,
      entity_id: 3,
      kind: 'merchant_descriptor',
      value: 'CIRCLE K 4411',
      confirmed: true,
    },
    {
      id: 3,
      entity_id: 3,
      kind: 'iban',
      value: 'EE111222333',
      confirmed: false,
    },
  ],
} as Entity;

const EXPENSES = [
  {
    id: 1,
    supplier_id: 3,
    category: 'fuel',
    gross_amount: 4820,
    vat_amount: 869,
    currency: 'EUR',
    tax_point_date: '2026-06-10',
    status: 'posted',
    reconciled: true,
    supplier_invoice_number: null,
  },
  {
    id: 2,
    supplier_id: 3,
    category: 'fuel',
    gross_amount: 1000,
    vat_amount: 180,
    currency: 'EUR',
    tax_point_date: '2026-06-11',
    status: 'posted',
    reconciled: false,
    supplier_invoice_number: null,
  },
  {
    id: 3,
    supplier_id: 3,
    category: 'office',
    gross_amount: 500,
    vat_amount: 90,
    currency: 'EUR',
    tax_point_date: '2026-06-12',
    status: 'draft',
    supplier_invoice_number: null,
  },
] as Expense[];

function mount(id = '3') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(
    [
      { path: '/settings/entities/:id', element: <EntityScreen /> },
      { path: '/settings/entities', element: <div>LIST</div> },
    ],
    { initialEntries: [`/settings/entities/${id}`] },
  );
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
      <AppToaster />
    </QueryClientProvider>,
  );
  return router;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getEntity).mockResolvedValue(SUPPLIER);
  vi.mocked(getExpenses).mockResolvedValue(EXPENSES);
  vi.mocked(getInvoices).mockResolvedValue([]);
});

describe('EntityScreen (asset §8 card)', () => {
  it('renders identity, linked-expenses link, aliases with unconfirmed marker, memory', async () => {
    mount();
    expect(await screen.findByText('Circle K Eesti AS')).toBeInTheDocument();
    expect(screen.getByText('EE100511246')).toBeInTheDocument();
    // Linked bookings: 2 non-draft expenses, 58.20 € total, real Books link.
    const link = await screen.findByRole('link', { name: /Expenses · 2/ });
    expect(link).toHaveAttribute(
      'href',
      '/books?seg=expenses&q=Circle+K+Eesti+AS',
    );
    expect(screen.getByText('−58.20 €')).toBeInTheDocument();
    // Aliases (registration_key is identity, NOT an alias chip).
    expect(screen.getByText('CIRCLE K 4411')).toBeInTheDocument();
    expect(screen.getByText(/EE111222333/)).toBeInTheDocument();
    expect(screen.getByText(/unconfirmed/)).toBeInTheDocument();
    // Classification memory derived from posted rows: fuel 2 of 2 posted.
    expect(screen.getByText('fuel (2 of 2)')).toBeInTheDocument();
    expect(screen.getByText('AI hint, not a rule')).toBeInTheDocument();
  });

  it('adds an alias through the sheet with the exact payload', async () => {
    vi.mocked(addEntityAlias).mockResolvedValue({
      id: 9,
      entity_id: 3,
      kind: 'name_alias',
      value: 'CIRCLEK',
      confirmed: true,
    } as never);
    mount();
    await screen.findByText('Circle K Eesti AS');
    fireEvent.click(screen.getByRole('button', { name: '＋ Add alias' }));
    fireEvent.change(screen.getByLabelText('Kind'), {
      target: { value: 'name_alias' },
    });
    fireEvent.change(screen.getByLabelText('Value'), {
      target: { value: ' CIRCLEK ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add alias' }));
    await waitFor(() =>
      expect(addEntityAlias).toHaveBeenCalledWith(3, {
        kind: 'name_alias',
        value: 'CIRCLEK',
      }),
    );
  });

  it('edits name/country/goods through the PATCH sheet', async () => {
    vi.mocked(updateEntity).mockResolvedValue({
      ...SUPPLIER,
      name: 'Circle K AS',
    } as never);
    mount();
    await screen.findByText('Circle K Eesti AS');
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const sheet = screen.getByRole('dialog');
    fireEvent.change(within(sheet).getByLabelText('Name'), {
      target: { value: 'Circle K AS' },
    });
    fireEvent.click(
      within(sheet).getByRole('button', { name: 'Save changes' }),
    );
    await waitFor(() =>
      expect(updateEntity).toHaveBeenCalledWith(3, {
        name: 'Circle K AS',
        country: 'EE',
        goodsVsServices: 'goods',
      }),
    );
  });

  it('delete: confirm-gated; the 409 reaches the operator verbatim', async () => {
    vi.mocked(deleteEntity).mockRejectedValue(
      new Error(
        'Entity 3 (Circle K Eesti AS) is referenced by an expense/invoice — cannot delete.',
      ),
    );
    mount();
    await screen.findByText('Circle K Eesti AS');
    fireEvent.click(screen.getByRole('button', { name: 'Delete entity…' }));
    // Nothing deleted until the dialog confirm.
    expect(deleteEntity).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Delete entity' }));
    expect(
      await screen.findByText(
        'Entity 3 (Circle K Eesti AS) is referenced by an expense/invoice — cannot delete.',
      ),
    ).toBeInTheDocument();
  });

  it('successful delete navigates back to the list', async () => {
    vi.mocked(deleteEntity).mockResolvedValue(SUPPLIER as never);
    const router = mount();
    await screen.findByText('Circle K Eesti AS');
    fireEvent.click(screen.getByRole('button', { name: 'Delete entity…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete entity' }));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/settings/entities'),
    );
  });

  it('employee card: email identity read-only, no memory/bookings fabrication', async () => {
    vi.mocked(getEntity).mockResolvedValue({
      id: 9,
      role: 'employee',
      country: 'EE',
      name: 'Mari Maasikas',
      goods_vs_services: null,
      identifiers: [
        {
          id: 5,
          entity_id: 9,
          kind: 'email',
          value: 'mari@example.com',
          confirmed: true,
        },
        {
          id: 6,
          entity_id: 9,
          kind: 'tg_user_id',
          value: '123456789',
          confirmed: true,
        },
      ],
    } as Entity);
    mount('9');
    expect(await screen.findByText('Mari Maasikas')).toBeInTheDocument();
    expect(screen.getByText('mari@example.com')).toBeInTheDocument();
    expect(screen.getByText('123456789')).toBeInTheDocument();
    expect(screen.queryByText(/Usually categorised/)).toBeNull();
    expect(screen.queryByText(/Expenses ·/)).toBeNull();
  });

  it('bad :id → honest not-found, no fetch storm', async () => {
    mount('banana');
    expect(
      await screen.findByText('This entity does not exist'),
    ).toBeInTheDocument();
    expect(getEntity).not.toHaveBeenCalled();
  });

  it('bookings row waits for the expenses list to settle (no transient false zero, P04)', async () => {
    let resolveExpenses!: (v: Expense[]) => void;
    vi.mocked(getExpenses).mockReturnValue(
      new Promise((resolve) => {
        resolveExpenses = resolve;
      }),
    );
    mount();
    await screen.findByText('Circle K Eesti AS');
    // Entity settled, but the shared expenses list is still pending — no
    // "Expenses · 0 / −0.00 €" ghost row.
    expect(screen.queryByText(/Expenses ·/)).toBeNull();
    resolveExpenses(EXPENSES);
    expect(
      await screen.findByRole('link', { name: /Expenses · 2/ }),
    ).toBeInTheDocument();
  });

  it('bookings row states its count basis (posted + pending, not drafts)', async () => {
    mount();
    await screen.findByText('Circle K Eesti AS');
    // The bookings row only renders once the shared expenses list settles
    // (P04 no-transient-false-zero gate above) — a second async wait,
    // consistent with the existing "waits for the expenses list to settle"
    // pin in this file.
    expect(
      await screen.findByText('Posted and pending — drafts not counted'),
    ).toBeInTheDocument();
  });

  it("alias Kind select offers exactly the three server-accepted kinds (AddAliasInput['kind'])", async () => {
    mount();
    await screen.findByText('Circle K Eesti AS');
    fireEvent.click(screen.getByRole('button', { name: '＋ Add alias' }));
    const options = within(screen.getByLabelText('Kind')).getAllByRole(
      'option',
    );
    expect(options.map((o) => (o as HTMLOptionElement).value)).toEqual([
      'merchant_descriptor',
      'iban',
      'name_alias',
    ]);
  });

  it('alias and edit sheets reset across open/close/reopen', async () => {
    mount();
    await screen.findByText('Circle K Eesti AS');
    fireEvent.click(screen.getByRole('button', { name: '＋ Add alias' }));
    fireEvent.change(await screen.findByLabelText('Value'), {
      target: { value: 'HALF-TYPED' },
    });
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByLabelText('Value')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: '＋ Add alias' }));
    expect(await screen.findByLabelText('Value')).toHaveValue('');

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByLabelText('Value')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(await screen.findByLabelText('Name'), {
      target: { value: 'Scratch that' },
    });
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByLabelText('Name')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(await screen.findByLabelText('Name')).toHaveValue(
      'Circle K Eesti AS',
    );
  });
});
