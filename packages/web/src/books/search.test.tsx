import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen } from '@testing-library/react';
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

const ENTITIES = [
  { id: 1, role: 'supplier', country: 'EE', name: 'Office Depot' },
  { id: 2, role: 'customer', country: 'EE', name: 'Acme Customer' },
];
const expense = (id: number, supplier: number | null, category: string) => ({
  id,
  supplier_id: supplier,
  category,
  gross_amount: 12345 * id,
  vat_amount: 0,
  currency: 'EUR',
  tax_point_date: '2026-07-0' + id,
  supplier_invoice_number: null,
  status: 'posted',
  reconciled: false,
});
// 123.45 (expense 1), 246.90 (expense 2).
const EXPENSES = [expense(1, 1, 'software'), expense(2, null, 'office rent')];
const INVOICES = [
  {
    id: 1,
    customer_id: 2,
    invoice_number: 'INV-7',
    gross_amount: 12345,
    vat_amount: 0,
    currency: 'EUR',
    tax_point_date: '2026-07-01',
    due_date: null,
    document_id: null,
    status: 'posted',
    sent_at: null,
    supply_type: null,
  },
];
const doc = (id: number, filename: string, supplier: string | null) => ({
  id,
  expense_id: null,
  filename,
  supplier_name: supplier,
  status: 'processed',
  channel: 'upload',
  created_at: id,
  claimant_name: null,
  reason_type: null,
});
const DOCS = [
  doc(1, 'receipt-123.45.pdf', 'Office Depot'),
  doc(2, 'scan.pdf', null),
];
const note = (id: number, type: string, objectId: number) => ({
  id,
  credit_note_number: `CN-${id}`,
  status: 'posted',
  gross_amount: 12345,
  vat_amount: 0,
  currency: 'EUR',
  tax_point_date: '2026-07-10',
  created_at: id,
  credits_object_type: type,
  credits_object_id: objectId,
});
// CN-1 credits Acme Customer's INV-7; CN-2 credits Office Depot's software
// expense. Both are 123.45 — an amount credit notes are NOT searched by.
const NOTES = [note(1, 'sales_invoice', 1), note(2, 'expense', 1)];

beforeEach(() => {
  vi.mocked(getExpenses).mockResolvedValue(EXPENSES as never);
  vi.mocked(getInvoices).mockResolvedValue(INVOICES as never);
  vi.mocked(getEntities).mockResolvedValue(ENTITIES as never);
  vi.mocked(getDocuments).mockResolvedValue(DOCS as never);
  vi.mocked(listCreditNotes).mockResolvedValue(NOTES as never);
});

function mount(search: string, state?: unknown) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(
    [
      { path: '/', element: <p>home</p> },
      { path: '/books', element: <BooksScreen /> },
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

const params = (router: ReturnType<typeof mount>) =>
  new URLSearchParams(router.state.location.search);
const bar = () => screen.findByRole('group', { name: 'Active filters' });

const HINTS = [
  {
    seg: 'expenses',
    name: 'Search expenses',
    placeholder: 'Supplier, invoice no., category, amount…',
    scope: 'supplier, invoice number, category or amount',
  },
  {
    seg: 'invoices',
    name: 'Search invoices',
    placeholder: 'Customer, invoice number, amount…',
    scope: 'customer, invoice number or amount',
  },
  {
    seg: 'documents',
    name: 'Search documents',
    placeholder: 'File name or supplier…',
    scope: 'file name or supplier',
  },
  {
    seg: 'credit-notes',
    name: 'Search credit notes',
    placeholder: 'Note number, counterparty, invoice number, category…',
    scope:
      'credit note number, credited customer or supplier, invoice number or expense category',
  },
] as const;

describe('Books search scope (issue #276)', () => {
  it.each(HINTS)(
    '$seg: the field names its segment and describes what it matches',
    async ({ seg, name, placeholder, scope }) => {
      mount(`?seg=${seg}`);
      const box = await screen.findByRole('searchbox', { name });
      expect(box).toHaveAttribute('placeholder', placeholder);
      expect(box).toHaveAccessibleDescription(`Matches ${scope}.`);
    },
  );

  // The line also carries the shown rows' total (issue #279): expenses as
  // outflow, invoices as inflow, credit notes as the signed net (a sales
  // note −, a purchase note +); documents have none.
  it.each([
    // An amount: matched where the hint promises it, nowhere else.
    ['expenses', '123.45', 'Showing 1 of 2 expenses · total −123.45 €'],
    ['invoices', '123.45', 'Showing 1 of 1 invoices · total +123.45 €'],
    ['documents', '123.45', 'Showing 1 of 2 documents'], // the file NAME
    ['documents', '246.90', 'Showing 0 of 2 documents'],
    ['credit-notes', '123.45', 'Showing 0 of 2 credit notes'],
    // What the credit-note hint promises is actually matched.
    ['credit-notes', 'cn-1', 'Showing 1 of 2 credit notes · net −123.45 €'],
    ['credit-notes', 'acme', 'Showing 1 of 2 credit notes · net −123.45 €'],
    [
      'credit-notes',
      'office depot',
      'Showing 1 of 2 credit notes · net +123.45 €',
    ],
    ['credit-notes', 'inv-7', 'Showing 1 of 2 credit notes · net −123.45 €'],
    ['credit-notes', 'software', 'Showing 1 of 2 credit notes · net +123.45 €'],
  ])('%s ?q=%s → %s, with the scope shown', async (seg, q, shown) => {
    mount(`?seg=${seg}&q=${encodeURIComponent(q)}`);
    const scope = HINTS.find((h) => h.seg === seg)!.scope;
    await vi.waitFor(async () =>
      expect(await bar()).toHaveTextContent(
        `${shown} · Search “${q}” in ${scope}`,
      ),
    );
  });

  it('a search carried to another segment keeps its value and says what it looks at there', async () => {
    const router = mount('?seg=expenses&q=office&status=posted');
    await vi.waitFor(async () =>
      expect(await bar()).toHaveTextContent(
        'Showing 2 of 2 expenses · total −370.35 € · Posted · Search “office” in supplier, invoice number, category or amount',
      ),
    );
    const transfers = [
      [
        'Invoices',
        'Showing 0 of 1 invoices',
        'customer, invoice number or amount',
      ],
      ['Documents', 'Showing 1 of 2 documents', 'file name or supplier'],
      [
        'Credit notes',
        'Showing 1 of 2 credit notes · net +123.45 €',
        HINTS[3].scope,
      ],
    ] as const;
    for (const [tab, shown, scope] of transfers) {
      await userEvent.click(screen.getByRole('tab', { name: tab }));
      await vi.waitFor(async () =>
        expect(await bar()).toHaveTextContent(
          `${shown} · Search “office” in ${scope}`,
        ),
      );
      expect(screen.getByRole('searchbox')).toHaveValue('office');
      expect(params(router).get('q')).toBe('office');
      expect(params(router).get('status')).toBeNull();
    }
  });

  const LONG = 'EECTB-' + '1805772/'.repeat(12);
  it.each([
    // Copied from Facts with stray case and outer whitespace: that one row.
    [
      `  ${LONG.toLowerCase()}alpha `,
      'Showing 1 of 5 expenses · total −370.35 €',
      3,
    ],
    // The shared prefix finds both same-prefix numbers.
    [LONG, 'Showing 2 of 5 expenses · total −864.15 €', null],
    // Stored tab/NBSP/double space read as single spaces.
    ['inv 2026 gamma', 'Showing 1 of 5 expenses · total −617.25 €', 5],
  ])(
    'expenses ?q=%j matches the supplier invoice number → %s (issue #277)',
    async (q, shown, id) => {
      vi.mocked(getExpenses).mockResolvedValue([
        ...EXPENSES,
        { ...expense(3, 1, 'fuel'), supplier_invoice_number: `${LONG}ALPHA` },
        { ...expense(4, 1, 'fuel'), supplier_invoice_number: `${LONG}BETA` },
        {
          ...expense(5, 1, 'fuel'),
          supplier_invoice_number: 'INV\t2026\u00a0 GAMMA',
        },
      ] as never);
      mount(`?seg=expenses&q=${encodeURIComponent(q)}`);
      // A long search is abbreviated in the bar; the count and scope are not.
      await vi.waitFor(async () =>
        expect(await bar()).toHaveTextContent(`${shown} · Search “`),
      );
      expect(await bar()).toHaveTextContent(`” in ${HINTS[0].scope}`);
      const numbers = screen.getAllByText(/Invoice no\./);
      expect(numbers).toHaveLength(id === null ? 2 : 1);
      if (id !== null) {
        expect(numbers[0].closest('a')).toHaveAttribute(
          'href',
          `/books/expenses/${id}`,
        );
        expect(numbers[0]).toHaveTextContent(
          id === 3 ? `Invoice no. ${LONG}ALPHA` : 'Invoice no. INV 2026 GAMMA',
        );
      }
    },
  );

  it('typing keeps other params and the entry state, replacing history', async () => {
    const router = mount('?seg=expenses&status=posted&keep=1', {
      origin: 'x',
    });
    await userEvent.type(
      await screen.findByRole('searchbox', { name: 'Search expenses' }),
      'so',
    );
    expect(params(router).toString()).toBe(
      'seg=expenses&status=posted&keep=1&q=so',
    );
    expect(router.state.location.state).toEqual({ origin: 'x' });
    await userEvent.clear(screen.getByRole('searchbox'));
    expect(params(router).has('q')).toBe(false);
    expect(router.state.location.state).toEqual({ origin: 'x' });
    // Still one Books entry: Back leaves Books.
    await act(() => router.navigate(-1));
    expect(router.state.location.pathname).toBe('/');
  });

  it('tapping the segment already on screen keeps its filters and search', async () => {
    const router = mount('?seg=expenses&status=posted&q=office', {
      origin: 'x',
    });
    await userEvent.click(await screen.findByRole('tab', { name: 'Expenses' }));
    expect(params(router).get('status')).toBe('posted');
    expect(params(router).get('q')).toBe('office');
    expect(router.state.location.state).toEqual({ origin: 'x' });
  });

  it('a legacy ?tab= link keeps its search and gets that segment’s hint', async () => {
    const router = mount('?tab=credit-notes&q=CN-2');
    expect(
      await screen.findByRole('searchbox', { name: 'Search credit notes' }),
    ).toHaveValue('CN-2');
    await vi.waitFor(() =>
      expect(params(router).toString()).toBe('q=CN-2&seg=credit-notes'),
    );
  });
});
