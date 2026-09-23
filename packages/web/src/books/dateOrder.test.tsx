import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
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

const expense = (
  id: number,
  day: string,
  cents: number,
  currency = 'EUR',
  status = 'posted',
) => ({
  id,
  supplier_id: null,
  category: `cat-${id}`,
  gross_amount: cents,
  vat_amount: 0,
  currency,
  tax_point_date: day,
  supplier_invoice_number: null,
  status,
  reconciled: false,
});
// July has the largest EUR row; September mixes EUR and USD (#279).
const EXPENSES = [
  expense(1, '2026-07-01', 90000),
  expense(2, '2026-07-31', 1000, 'EUR', 'draft'),
  expense(3, '2026-08-01', 5000),
  expense(4, '2026-09-10', 140000),
  expense(5, '2026-09-12', 50000, 'USD'),
  expense(6, '2026-06-30', 7000),
];
const at = (y: number, m: number, d: number) =>
  new Date(y, m - 1, d, 12).getTime() / 1000;
const DOCS = [
  { id: 1, created_at: at(2026, 7, 1), filename: 'july.pdf' },
  { id: 2, created_at: at(2026, 8, 15), filename: 'august.pdf' },
].map((d) => ({
  ...d,
  expense_id: null,
  supplier_name: null,
  status: 'processed',
  channel: 'upload',
  claimant_name: null,
  reason_type: null,
}));
const note = (id: number, day: string, cents: number, type: string) => ({
  id,
  credit_note_number: `CN-${id}`,
  status: 'posted',
  gross_amount: cents,
  vat_amount: 0,
  currency: 'EUR',
  tax_point_date: day,
  created_at: 1,
  credits_object_type: type,
  credits_object_id: 99,
});
const NOTES = [
  note(1, '2026-07-10', 3000, 'sales_invoice'),
  note(2, '2026-07-12', 1000, 'expense'),
  note(3, '2026-09-01', 500, 'expense'),
];

beforeEach(() => {
  vi.mocked(getExpenses).mockResolvedValue(EXPENSES as never);
  vi.mocked(getInvoices).mockResolvedValue([] as never);
  vi.mocked(getEntities).mockResolvedValue([] as never);
  vi.mocked(getDocuments).mockResolvedValue(DOCS as never);
  vi.mocked(listCreditNotes).mockResolvedValue(NOTES as never);
});

function mount(url: string, state?: unknown) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(
    [
      { path: '/', element: <p>home</p> },
      { path: '/books', element: <BooksScreen /> },
      { path: '/reports', element: <p>reports screen</p> },
    ],
    { initialEntries: ['/', { pathname: '/books', search: url, state }] },
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

const bar = () => screen.getByRole('group', { name: 'Active filters' });
const params = (r: ReturnType<typeof mount>) =>
  new URLSearchParams(r.state.location.search);
/** Row ids of a segment, in rendered order. */
const rowIds = (kind: string) =>
  screen
    .getAllByRole('link')
    .map((a) => a.getAttribute('href') ?? '')
    .filter((h) => h.startsWith(`/books/${kind}/`) && !h.endsWith('/new'))
    .map((h) => Number(h.split('/').pop()));
const headers = () =>
  Array.from(document.querySelectorAll('p.uppercase')).map((p) =>
    (p.textContent ?? '').replace(/\u00a0/g, ' '),
  );

describe('Books date range + order (issue #279)', () => {
  it('an inclusive range restricts rows, chip counts, month totals and the line', async () => {
    mount('?from=2026-07-01&to=2026-07-31');
    await screen.findByText(rowTitle('cat-1'));
    expect(rowIds('expenses')).toEqual([2, 1]);
    // Both calendar bounds included; June 30 and August 1 are out.
    expect(bar()).toHaveTextContent(
      'Showing 2 of 6 expenses · total −910.00 € · Tax point 1 Jul 2026 – 31 Jul 2026',
    );
    expect(screen.getByRole('button', { name: 'Draft 1' })).toBeInTheDocument();
    expect(headers()).toEqual(['July 2026−910.00 € · 2']);
  });

  it('a single-sided range is applied and named', async () => {
    mount('?from=2026-08-01');
    await screen.findByText(rowTitle('cat-3'));
    expect(rowIds('expenses')).toEqual([5, 4, 3]);
    expect(bar()).toHaveTextContent('Tax point from 1 Aug 2026');
  });

  it('month totals stay per currency — EUR and USD are never summed', async () => {
    mount('?from=2026-09-01');
    await screen.findByText(rowTitle('cat-4'));
    expect(headers()).toEqual(['September 2026−1400.00 € · −500.00 USD · 2']);
    expect(bar()).toHaveTextContent('total −1400.00 € · −500.00 USD');
    // Rows carry their own currency, not a € mark.
    const usdRow = screen
      .getAllByRole('link')
      .find((a) => a.getAttribute('href') === '/books/expenses/5')!;
    expect(usdRow).toHaveTextContent('500.00 USD');
    expect(usdRow).not.toHaveTextContent('€');
  });

  it('oldest first reverses months and rows', async () => {
    mount('?sort=oldest');
    await screen.findByText(rowTitle('cat-1'));
    expect(rowIds('expenses')).toEqual([6, 1, 2, 3, 4, 5]);
    expect(headers()[0]).toMatch(/^June 2026/);
    expect(bar()).toHaveTextContent('Oldest first');
  });

  it('largest amount is one ranking across months, one section per currency', async () => {
    mount('?sort=largest');
    await screen.findByText(rowTitle('cat-1'));
    expect(rowIds('expenses')).toEqual([4, 1, 6, 3, 2, 5]);
    expect(headers()).toEqual([
      'Amounts in EUR−2430.00 € · 5',
      'Amounts in USD−500.00 USD · 1',
    ]);
    expect(screen.queryByText('July 2026')).toBeNull();
  });

  it('smallest amount composes with the range and the status filter', async () => {
    mount('?sort=smallest&status=posted&from=2026-07-01');
    await screen.findByText(rowTitle('cat-1'));
    expect(rowIds('expenses')).toEqual([3, 1, 4, 5]);
  });

  it('an invalid date is not claimed as applied; the list is unrestricted by it', async () => {
    mount('?from=2026-02-30');
    await screen.findByText(rowTitle('cat-1'));
    expect(rowIds('expenses')).toHaveLength(6);
    expect(bar()).toHaveTextContent(
      'Showing 6 of 6 expenses · total −2430.00 € · −500.00 USD · From “2026-02-30” not applied (not a date)',
    );
    const from = screen.getByLabelText('From');
    expect(from).toHaveValue('');
    expect(from).toHaveAttribute('aria-invalid', 'true');
    expect(from).toHaveAccessibleDescription(
      expect.stringContaining('not a real date'),
    );
  });

  it('a reversed range restricts nothing and says so; both inputs are marked', async () => {
    mount('?from=2026-09-01&to=2026-07-01');
    await screen.findByText(rowTitle('cat-1'));
    expect(rowIds('expenses')).toHaveLength(6);
    expect(bar()).toHaveTextContent('Dates not applied: From is after To');
    expect(screen.getByLabelText('From')).toHaveValue('2026-09-01');
    expect(screen.getByLabelText('To')).toHaveAttribute('aria-invalid', 'true');
  });

  it('an unknown order is noted; an empty one is simply the default', async () => {
    mount('?sort=biggest');
    await screen.findByText(rowTitle('cat-1'));
    expect(bar()).toHaveTextContent(
      'Order “biggest” not recognised — newest first',
    );
    expect(rowIds('expenses')).toEqual([5, 4, 3, 2, 1, 6]);
  });

  it('while loading, the restrictions show without counts or totals', async () => {
    vi.mocked(getExpenses).mockReturnValue(new Promise(() => {}) as never);
    mount('?from=2026-07-01&sort=largest');
    await waitFor(() =>
      expect(bar()).toHaveTextContent(
        'Filtered by: Tax point from 1 Jul 2026 · Largest amount first',
      ),
    );
    expect(bar()).not.toHaveTextContent('Showing');
    expect(bar()).not.toHaveTextContent('total');
  });

  it('the controls write the URL in place: replace-history, entry state and other params kept', async () => {
    const router = mount('?keep=1', { origin: 'x' });
    await screen.findByText(rowTitle('cat-1'));
    await userEvent.click(screen.getByText('Dates & order'));
    await userEvent.selectOptions(screen.getByLabelText('Order'), 'oldest');
    expect(params(router).toString()).toBe('keep=1&sort=oldest');
    fireEvent.change(screen.getByLabelText('From'), {
      target: { value: '2026-09-01' },
    });
    expect(params(router).get('from')).toBe('2026-09-01');
    expect(rowIds('expenses')).toEqual([4, 5]);
    // Cleared (or an incomplete native value) deletes the bound.
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '' } });
    expect(params(router).has('from')).toBe(false);
    await userEvent.selectOptions(screen.getByLabelText('Order'), 'newest');
    expect(params(router).toString()).toBe('keep=1');
    expect(router.state.location.state).toEqual({ origin: 'x' });
    expect(router.state.historyAction).toBe('REPLACE');
    await act(() => router.navigate(-1));
    expect(router.state.location.pathname).toBe('/');
  });

  it('the disclosure opens for a URL with dates/order and names them while closed', async () => {
    mount('?from=2026-07-01&to=2026-07-31&sort=oldest');
    await screen.findByText(rowTitle('cat-1'));
    const details = screen.getByText('Dates & order').closest('details')!;
    expect(details.open).toBe(true);
    expect(details.querySelector('summary')).toHaveTextContent(
      'Dates & order · 1 Jul 2026 – 31 Jul 2026 · oldest first',
    );
  });

  it('dates and order carry across a segment switch, visibly; segment filters do not', async () => {
    const router = mount(
      '?status=posted&from=2026-07-01&to=2026-07-31&sort=largest',
    );
    await screen.findByText(rowTitle('cat-1'));
    await userEvent.click(screen.getByRole('radio', { name: 'Credit notes' }));
    await screen.findByText(rowTitle('CN-1'));
    expect(params(router).get('status')).toBeNull();
    expect(params(router).get('sort')).toBe('largest');
    // Face value ranks: 30.00 then 10.00; the net is signed (−30 + 10).
    expect(rowIds('credit-notes')).toEqual([1, 2]);
    expect(bar()).toHaveTextContent(
      'Showing 2 of 3 credit notes · net −20.00 € · Tax point 1 Jul 2026 – 31 Jul 2026 · Largest amount first',
    );

    await userEvent.click(screen.getByRole('radio', { name: 'Documents' }));
    await screen.findByText(rowTitle('july.pdf'));
    expect(screen.queryByText('august.pdf')).toBeNull();
    expect(bar()).toHaveTextContent(
      'Showing 1 of 2 documents · Added 1 Jul 2026 – 31 Jul 2026 · Newest first — documents have no amount to order by',
    );
    expect(
      within(screen.getByLabelText('Order')).queryByRole('option', {
        name: /Largest/,
      }),
    ).toBeNull();
    // The unapplied amount order is kept for the segments that have amounts.
    expect(params(router).get('sort')).toBe('largest');
  });

  it('Reset clears dates and order with the filters and search; state and unrelated params stay', async () => {
    const router = mount(
      '?seg=expenses&status=posted&q=cat&from=2026-07-01&to=bogus&sort=largest&x=1',
      { origin: 'kept' },
    );
    await screen.findByText(rowTitle('cat-1'));
    await userEvent.click(
      screen.getByRole('button', {
        name: 'Reset filters, search, dates and order',
      }),
    );
    await waitFor(() =>
      expect(router.state.location.search).toBe('?seg=expenses&x=1'),
    );
    expect(router.state.location.state).toEqual({ origin: 'kept' });
    expect(router.state.historyAction).toBe('REPLACE');
    expect(rowIds('expenses')).toEqual([5, 4, 3, 2, 1, 6]);
  });

  it('Credit notes: dates make the button the Books Reset; a search alone keeps Clear search', async () => {
    const router = mount('?seg=credit-notes&q=CN&from=2026-09-01');
    await screen.findByText(rowTitle('CN-3'));
    expect(screen.queryByRole('button', { name: 'Clear search' })).toBeNull();
    await userEvent.click(
      screen.getByRole('button', {
        name: 'Reset filters, search, dates and order',
      }),
    );
    await waitFor(() =>
      expect(router.state.location.search).toBe('?seg=credit-notes'),
    );
  });

  it('the Reports pointer is a plain link: no Books state is handed to Reports', async () => {
    const router = mount('?from=2026-07-01', { origin: 'books-entry' });
    await screen.findByText(rowTitle('cat-1'));
    expect(
      screen.getByText(/calendar filter, not a reporting period/),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('link', { name: 'Reports' }));
    await screen.findByText('reports screen');
    expect(router.state.location.state).toBeNull();
    // Back returns to Books with the range intact.
    await act(() => router.navigate(-1));
    expect(router.state.location.search).toBe('?from=2026-07-01');
    expect(await screen.findByText(rowTitle('cat-1'))).toBeInTheDocument();
    expect(screen.queryByText('cat-6')).toBeNull();
  });
});

describe('Books date input keeps native keyboard entry (issue #279 rework)', () => {
  /** Record every write the app makes into the input's value or its value
   *  attribute — a write-back mid-typing resets the browser's segment
   *  buffer (root browser evidence: 2026 typed became year 0000 → cleared). */
  function watchWrites(el: HTMLInputElement) {
    const writes: string[] = [];
    const proto = HTMLInputElement.prototype;
    for (const prop of ['value', 'defaultValue'] as const) {
      const d = Object.getOwnPropertyDescriptor(proto, prop)!;
      Object.defineProperty(el, prop, {
        configurable: true,
        get() {
          return d.get!.call(this);
        },
        set(v: string) {
          writes.push(`${prop}=${v}`);
          d.set!.call(this, v);
        },
      });
    }
    const setAttribute = el.setAttribute.bind(el);
    el.setAttribute = (name: string, v: string) => {
      if (name === 'value') writes.push(`attr=${v}`);
      setAttribute(name, v);
    };
    return writes;
  }
  /** What the browser does per keystroke: its own value, then `input`. */
  function browserTypes(el: HTMLInputElement, value: string, bad = false) {
    const d = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!;
    d.set!.call(el, value);
    Object.defineProperty(el, 'validity', {
      configurable: true,
      value: { badInput: bad },
    });
    fireEvent.input(el);
  }

  it('year typed digit by digit: each complete value commits, nothing is written back', async () => {
    const router = mount('?keep=1', { origin: 'x' });
    await screen.findByText(rowTitle('cat-1'));
    const from = screen.getByLabelText('From') as HTMLInputElement;
    const writes = watchWrites(from);
    // Month + day typed first: incomplete → nothing committed.
    browserTypes(from, '', true);
    expect(params(router).has('from')).toBe(false);
    for (const v of ['0002-09-01', '0020-09-01', '0202-09-01', '2026-09-01']) {
      browserTypes(from, v);
      await waitFor(() => expect(params(router).get('from')).toBe(v));
    }
    expect(writes).toEqual([]);
    expect(from.value).toBe('2026-09-01');
    expect(rowIds('expenses')).toEqual([5, 4]);
    expect(router.state.location.state).toEqual({ origin: 'x' });
    expect(params(router).get('keep')).toBe('1');
  });

  it('an incomplete entry over an applied bound keeps the bound (and says so)', async () => {
    const router = mount('?from=2026-07-01');
    await screen.findByText(rowTitle('cat-1'));
    const from = screen.getByLabelText('From') as HTMLInputElement;
    expect(from.value).toBe('2026-07-01');
    browserTypes(from, '', true);
    expect(params(router).get('from')).toBe('2026-07-01');
    expect(bar()).toHaveTextContent('Tax point from 1 Jul 2026');
  });

  it('a deliberate clear (empty, not badInput) removes the bound', async () => {
    const router = mount('?from=2026-07-01');
    await screen.findByText(rowTitle('cat-1'));
    browserTypes(screen.getByLabelText('From') as HTMLInputElement, '');
    await waitFor(() => expect(params(router).has('from')).toBe(false));
  });

  it('URL changes from elsewhere still reach the field: Reset, Back, deep link', async () => {
    const router = mount('?from=2026-07-01&to=2026-07-31');
    await screen.findByText(rowTitle('cat-1'));
    const from = screen.getByLabelText('From') as HTMLInputElement;
    const to = screen.getByLabelText('To') as HTMLInputElement;
    expect(to.value).toBe('2026-07-31');
    await userEvent.click(
      screen.getByRole('button', {
        name: 'Reset filters, search, dates and order',
      }),
    );
    await waitFor(() => expect(from.value).toBe(''));
    expect(to.value).toBe('');
    // A navigation to a Books link with a range (then Back) syncs too.
    await act(() => router.navigate('/books?from=2026-09-01'));
    await waitFor(() =>
      expect((screen.getByLabelText('From') as HTMLInputElement).value).toBe(
        '2026-09-01',
      ),
    );
    await act(() => router.navigate(-1));
    await waitFor(() =>
      expect((screen.getByLabelText('From') as HTMLInputElement).value).toBe(
        '',
      ),
    );
  });

  it('Reset after deleting the year of a bound explicitly clears the field (its value already reads empty)', async () => {
    mount('?from=2026-07-01');
    await screen.findByText(rowTitle('cat-1'));
    const from = screen.getByLabelText('From') as HTMLInputElement;
    // The year deleted: native value '' + badInput, month/day still shown.
    browserTypes(from, '', true);
    const writes = watchWrites(from);
    await userEvent.click(
      screen.getByRole('button', {
        name: 'Reset filters, search, dates and order',
      }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole('group', { name: 'Active filters' }),
      ).toBeNull(),
    );
    // Assigned even though '' === '' — that is what clears the segments.
    expect(writes).toEqual(['value=']);
  });

  it('Reset clears a partial entry that never reached the URL (other bound valid), without remounting', async () => {
    const router = mount('?to=2026-07-31&q=cat');
    await screen.findByText(rowTitle('cat-1'));
    const from = screen.getByLabelText('From') as HTMLInputElement;
    const to = screen.getByLabelText('To') as HTMLInputElement;
    // Month/day typed into the blank From: badInput, no ?from= ever.
    browserTypes(from, '', true);
    expect(params(router).has('from')).toBe(false);
    const fromWrites = watchWrites(from);
    const toWrites = watchWrites(to);
    await userEvent.click(
      screen.getByRole('button', {
        name: 'Reset filters, search, dates and order',
      }),
    );
    await waitFor(() => expect(router.state.location.search).toBe(''));
    // Both native buffers explicitly cleared; the same elements (no remount).
    expect(fromWrites).toEqual(['value=']);
    expect(toWrites).toEqual(['value=']);
    expect(screen.getByLabelText('From')).toBe(from);
    expect(screen.getByLabelText('To')).toBe(to);
  });

  it('Back to an entry whose bound equals this field’s own last write still resyncs it', async () => {
    const router = mount('?from=2026-09-01');
    await screen.findByText(rowTitle('cat-4'));
    await act(() => router.navigate('/books'));
    const from = screen.getByLabelText('From') as HTMLInputElement;
    await waitFor(() => expect(from.value).toBe(''));
    browserTypes(from, '2026-09-01'); // own write (replace)
    await waitFor(() => expect(params(router).get('from')).toBe('2026-09-01'));
    browserTypes(from, '', true); // then the year deleted again
    const writes = watchWrites(from);
    await act(() => router.navigate(-1)); // POP to ?from=2026-09-01
    await waitFor(() => expect(writes).toEqual(['value=2026-09-01']));
  });

  it('another filter’s write does not touch a date field mid-entry', async () => {
    mount('');
    await screen.findByText(rowTitle('cat-1'));
    const from = screen.getByLabelText('From') as HTMLInputElement;
    browserTypes(from, '', true);
    const writes = watchWrites(from);
    await userEvent.selectOptions(screen.getByLabelText('Order'), 'oldest');
    await userEvent.click(screen.getByRole('button', { name: /^Posted/ }));
    expect(writes).toEqual([]);
  });
});
