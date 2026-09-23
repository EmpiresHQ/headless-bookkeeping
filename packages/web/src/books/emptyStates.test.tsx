import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UnsavedChangesProvider } from '../lib/unsavedChanges';
import { BooksScreen } from './BooksScreen';

vi.mock('../api', async (io) => ({
  ...(await io<typeof import('../api')>()),
  getExpenses: vi.fn(),
  getInvoices: vi.fn(),
  getEntities: vi.fn(),
  getDocuments: vi.fn(),
  listCreditNotes: vi.fn(),
  getCategories: vi.fn().mockResolvedValue([]),
}));
import {
  getDocuments,
  getEntities,
  getExpenses,
  getInvoices,
  listCreditNotes,
} from '../api';
import { rowTitle } from './rowText.test-util';

/** Issue #280: initial empty / search-empty / filtered-empty / load error
 *  are told apart on the real BooksScreen, with the action that fits. */

const EXPENSES = [
  {
    id: 1,
    supplier_id: 7,
    category: 'travel',
    gross_amount: 12000,
    vat_amount: 0,
    currency: 'EUR',
    tax_point_date: '2026-07-10',
    supplier_invoice_number: 'S-100',
    status: 'posted',
    reconciled: false,
  },
];
const ENTITIES = [{ id: 7, name: 'Acme GmbH' }];
const NOTES = [
  {
    id: 1,
    credit_note_number: 'CN-1',
    status: 'posted',
    gross_amount: 500,
    vat_amount: 0,
    currency: 'EUR',
    tax_point_date: '2026-07-10',
    created_at: 1,
    credits_object_type: 'expense',
    credits_object_id: 1,
  },
];

beforeEach(() => {
  vi.mocked(getExpenses).mockResolvedValue(EXPENSES as never);
  vi.mocked(getInvoices).mockResolvedValue([] as never);
  vi.mocked(getEntities).mockResolvedValue(ENTITIES as never);
  vi.mocked(getDocuments).mockResolvedValue([] as never);
  vi.mocked(listCreditNotes).mockResolvedValue(NOTES as never);
});

function mount(search: string, state?: unknown) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(
    [
      { path: '/', element: <p>home</p> },
      { path: '/books', element: <BooksScreen /> },
      { path: '/books/credit-notes/new', element: <p>new credit note</p> },
    ],
    { initialEntries: ['/', { pathname: '/books', search, state }] },
  );
  render(
    <QueryClientProvider client={qc}>
      <UnsavedChangesProvider onUnauthorized={() => undefined}>
        <RouterProvider router={router} />
      </UnsavedChangesProvider>
    </QueryClientProvider>,
  );
  return router;
}

const SHOW_ALL = { name: 'Show all expenses' };

describe('Books empty states (issue #280)', () => {
  it('initial empty: "yet" + Create expense opens the + menu’s sheet; cancel keeps the URL', async () => {
    vi.mocked(getExpenses).mockResolvedValue([] as never);
    const router = mount('?x=1', { origin: 'kept' });
    expect(await screen.findByText('No expenses yet')).toBeInTheDocument();
    expect(screen.queryByText(/match/)).toBeNull();
    const create = screen.getByRole('button', { name: 'Create expense' });
    await userEvent.click(create);
    expect(
      await screen.findByRole('dialog', { name: 'New expense' }),
    ).toBeInTheDocument();
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: 'Escape',
    });
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'New expense' })).toBeNull(),
    );
    expect(router.state.location.search).toBe('?x=1');
    expect(router.state.location.state).toEqual({ origin: 'kept' });
  });

  it('initial empty with a search in the URL still offers Create, says nothing is hidden, and leaves the URL alone', async () => {
    vi.mocked(getExpenses).mockResolvedValue([] as never);
    const router = mount('?q=acme&status=draft');
    expect(await screen.findByText('No expenses yet')).toBeInTheDocument();
    expect(
      screen.getByText(/The search and filters are not hiding any/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Create expense' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', SHOW_ALL)).toBeNull();
    expect(router.state.location.search).toBe('?q=acme&status=draft');
  });

  it('Invoices initial empty opens the new-invoice sheet', async () => {
    mount('?seg=invoices');
    await userEvent.click(
      await screen.findByRole('button', { name: 'Create invoice' }),
    );
    expect(
      await screen.findByRole('dialog', { name: 'New sales invoice' }),
    ).toBeInTheDocument();
  });

  it('Documents initial empty offers Upload document', async () => {
    mount('?seg=documents');
    expect(await screen.findByText('No documents yet')).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole('button', { name: 'Upload document' }),
    );
    expect(
      await screen.findByRole('dialog', { name: 'Upload a document' }),
    ).toBeInTheDocument();
  });

  it('Credit notes initial empty: New credit note is the empty state’s action, shown once', async () => {
    vi.mocked(listCreditNotes).mockResolvedValue([] as never);
    mount('?seg=credit-notes');
    expect(await screen.findByText('No credit notes yet')).toBeInTheDocument();
    expect(
      screen.getAllByRole('link', { name: 'New credit note' }),
    ).toHaveLength(1);
  });

  it('Credit notes with rows keep the link above the list; a search-empty offers Show all, not a second link', async () => {
    mount('?seg=credit-notes&q=zzz');
    expect(
      await screen.findByText('No credit notes match “zzz”'),
    ).toBeInTheDocument();
    expect(
      screen.getAllByRole('link', { name: 'New credit note' }),
    ).toHaveLength(1);
    expect(
      screen.getByRole('button', { name: 'Show all credit notes' }),
    ).toBeInTheDocument();
  });

  it('search-empty names the search and its scope; no Create', async () => {
    mount('?q=zzz');
    expect(
      await screen.findByText('No expenses match “zzz”'),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'Searched supplier, invoice number, category or amount across 1 loaded expenses.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create expense' })).toBeNull();
  });

  it('a long search is a bounded excerpt in the empty state', async () => {
    const long = 'x'.repeat(200);
    mount(`?q=${long}`);
    expect(
      await screen.findByText(`No expenses match “${'x'.repeat(32)}…”`),
    ).toBeInTheDocument();
  });

  it('filtered-empty names only the filters that applied', async () => {
    mount('?status=draft&sort=oldest&from=bogus');
    expect(
      await screen.findByText('No expenses match these filters'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('None of the 1 loaded expenses: Draft.'),
    ).toBeInTheDocument();
  });

  it('a date range that removes every row is filtered-empty and names the bound', async () => {
    mount('?from=2026-08-01');
    expect(
      await screen.findByText('No expenses match these filters'),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'None of the 1 loaded expenses: Tax point from 1 Aug 2026.',
      ),
    ).toBeInTheDocument();
  });

  it('sort-only, reversed dates, unknown status and a blank search never empty the list', async () => {
    mount('?sort=largest&from=2026-09-01&to=2026-01-01&status=nope&q=%20%20');
    expect(await screen.findByText('Acme GmbH')).toBeInTheDocument();
    expect(screen.queryByRole('button', SHOW_ALL)).toBeNull();
  });

  it('No document is not counted as a filter while the archive is still loading', async () => {
    vi.mocked(getDocuments).mockReturnValue(new Promise(() => undefined));
    mount('?nodoc=1');
    expect(await screen.findByText('Acme GmbH')).toBeInTheDocument();
  });

  it('search + filters together say so; Show all clears everything, keeps seg/unrelated/state, focuses All', async () => {
    const router = mount(
      '?seg=expenses&q=zzz&status=draft&nodoc=1&from=2026-07-01&sort=oldest&x=1',
      { origin: 'kept' },
    );
    expect(
      await screen.findByText(
        'No expenses match this search and these filters',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /Search “zzz” in supplier, invoice number, category or amount with Draft · No document · Tax point from 1 Jul 2026 leaves none of the 1 loaded expenses\./,
      ),
    ).toBeInTheDocument();
    // Its name differs from the ActiveFilters Reset beside it.
    expect(
      screen.getByRole('button', {
        name: 'Reset filters, search, dates and order',
      }),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', SHOW_ALL));
    await waitFor(() =>
      expect(router.state.location.search).toBe('?seg=expenses&x=1'),
    );
    expect(router.state.location.state).toEqual({ origin: 'kept' });
    expect(router.state.historyAction).toBe('REPLACE');
    expect(await screen.findByText('Acme GmbH')).toBeInTheDocument();
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('button', { name: 'All' }),
      ),
    );
    expect(screen.getByLabelText('From')).toHaveValue('');
  });

  it('Show all also clears a partial date entry that never reached the URL', async () => {
    const router = mount('?q=zzz');
    await screen.findByText('No expenses match “zzz”');
    const from = screen.getByLabelText('From') as HTMLInputElement;
    const set = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!;
    // Browser's own partial buffer (badInput): reads empty, never committed.
    Object.defineProperty(from, 'validity', {
      configurable: true,
      value: { badInput: true },
    });
    set.call(from, '');
    fireEvent.input(from);
    const writes: string[] = [];
    Object.defineProperty(from, 'value', {
      configurable: true,
      get: () => '',
      set: (v: string) => {
        writes.push(v);
      },
    });
    await userEvent.click(screen.getByRole('button', SHOW_ALL));
    await waitFor(() => expect(router.state.location.search).toBe(''));
    expect(writes).toEqual(['']);
    expect(screen.getByLabelText('From')).toBe(from);
  });

  it('supplier names still loading: no "no match" claim, no scope claim', async () => {
    vi.mocked(getEntities).mockReturnValue(new Promise(() => undefined));
    mount('?q=acme');
    expect(
      await screen.findByText('Still loading supplier names'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/No expenses match/)).toBeNull();
    expect(
      screen.getByText(
        /Nothing matched “acme” in what has loaded for the 1 expenses\. Supplier names are not searched until they load\./,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Retry/ })).toBeNull();
  });

  it('supplier names failed: says so and Retry refetches them, after which the row matches', async () => {
    vi.mocked(getEntities).mockRejectedValueOnce(new Error('boom'));
    mount('?q=acme');
    expect(
      await screen.findByText("Couldn't search supplier names"),
    ).toBeInTheDocument();
    vi.mocked(getEntities).mockResolvedValue(ENTITIES as never);
    await userEvent.click(
      screen.getByRole('button', { name: 'Retry loading supplier names' }),
    );
    expect(await screen.findByText('Acme GmbH')).toBeInTheDocument();
  });

  it('a number/amount hit still shows while names are unavailable', async () => {
    vi.mocked(getEntities).mockRejectedValue(new Error('boom'));
    mount('?q=S-100');
    expect(await screen.findByText(rowTitle('travel'))).toBeInTheDocument();
  });

  it('Credit notes: a failed read gets Retry even while another is still loading, without claiming a full search', async () => {
    vi.mocked(getInvoices).mockRejectedValueOnce(new Error('boom'));
    vi.mocked(getExpenses).mockReturnValue(new Promise(() => undefined));
    mount('?seg=credit-notes&q=acme');
    expect(
      await screen.findByText(
        "Still loading expenses; couldn't search invoices",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Searched credit note number/)).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Retry loading invoices' }),
    ).toBeInTheDocument();
  });

  it('a failed primary load stays a LoadError with Retry — never an empty state', async () => {
    vi.mocked(getExpenses).mockRejectedValueOnce(new Error('Server down'));
    mount('');
    expect(await screen.findByText('Server down')).toBeInTheDocument();
    expect(screen.queryByText('No expenses yet')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Create expense' })).toBeNull();
    vi.mocked(getExpenses).mockResolvedValue([] as never);
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('No expenses yet')).toBeInTheDocument();
  });

  it('while the primary list loads, no empty state or create action is shown', async () => {
    vi.mocked(getExpenses).mockReturnValue(new Promise(() => undefined));
    mount('');
    await screen.findByRole('heading', { name: 'Books' });
    await act(async () => undefined);
    expect(screen.getAllByTestId('skeleton-row').length).toBeGreaterThan(0);
    expect(screen.queryByText('No expenses yet')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Create expense' })).toBeNull();
  });
});
