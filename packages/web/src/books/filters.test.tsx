import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UnsavedChangesProvider } from '../lib/unsavedChanges';
import { BooksScreen } from './BooksScreen';
import { resetFilterParams } from './filters';

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

const expense = (id: number, status: string, category: string) => ({
  id,
  supplier_id: null,
  category,
  gross_amount: 1000 * id,
  vat_amount: 0,
  currency: 'EUR',
  tax_point_date: '2026-07-0' + id,
  supplier_invoice_number: null,
  status,
  reconciled: false,
});
const EXPENSES = [
  expense(1, 'posted', 'software'),
  expense(2, 'reversed', 'fixture fuel'),
  expense(3, 'reversed', 'fixture travel'),
];
// Expense 3 has a document → ?nodoc=1 leaves expense 2 only.
const DOCS = [
  {
    id: 9,
    expense_id: 3,
    filename: 'fixture.pdf',
    supplier_name: null,
    status: 'error',
    channel: 'upload',
    created_at: 1,
    claimant_name: null,
    reason_type: null,
  },
  {
    id: 10,
    expense_id: null,
    filename: 'other.pdf',
    supplier_name: null,
    status: 'processed',
    channel: 'upload',
    created_at: 2,
    claimant_name: null,
    reason_type: null,
  },
];

beforeEach(() => {
  vi.mocked(getExpenses).mockResolvedValue(EXPENSES as never);
  vi.mocked(getInvoices).mockResolvedValue([] as never);
  vi.mocked(getEntities).mockResolvedValue([] as never);
  vi.mocked(getDocuments).mockResolvedValue(DOCS as never);
  vi.mocked(listCreditNotes).mockResolvedValue([] as never);
});

function mount(url: string, state?: unknown) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(
    [
      { path: '/', element: <p>home</p> },
      { path: '/books', element: <BooksScreen /> },
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
const reset = () =>
  screen.getByRole('button', {
    name: 'Reset filters, search, dates and order',
  });

describe('resetFilterParams (issue #274)', () => {
  it('drops the segment filters and the search, keeps seg and unrelated params', () => {
    const next = resetFilterParams(
      new URLSearchParams('seg=expenses&status=draft&nodoc=1&q=x&keep=1'),
      'expenses',
    );
    expect(next.toString()).toBe('seg=expenses&keep=1');
  });

  it('normalizes a legacy ?tab= to the segment on screen', () => {
    const next = resetFilterParams(
      new URLSearchParams('tab=documents&dstatus=error&q=x'),
      'documents',
    );
    expect(next.toString()).toBe('seg=documents');
  });
});

describe('Books active restrictions + Reset (issue #274)', () => {
  it('a URL-restored status + No document + search are all summarized over the rendered rows', async () => {
    mount('?status=corrected&nodoc=1&q=Fixture');
    await screen.findByText('fixture fuel');
    expect(bar()).toHaveTextContent(
      'Showing 1 of 3 expenses · total −20.00 € · Corrected · No document · Search “Fixture”',
    );
    expect(screen.queryByText('fixture travel')).toBeNull();
    expect(screen.getByRole('button', { name: /Corrected 2/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('Reset clears filters AND search, keeps seg/unrelated/state, replaces history, focuses All', async () => {
    const router = mount(
      '?seg=expenses&status=corrected&nodoc=1&q=Fixture&x=1',
      {
        origin: 'kept',
      },
    );
    await screen.findByText('fixture fuel');
    await userEvent.click(reset());
    await waitFor(() =>
      expect(router.state.location.search).toBe('?seg=expenses&x=1'),
    );
    expect(router.state.location.state).toEqual({ origin: 'kept' });
    expect(router.state.historyAction).toBe('REPLACE');
    expect(screen.queryByRole('group', { name: 'Active filters' })).toBeNull();
    expect(screen.getByRole('searchbox')).toHaveValue('');
    expect(screen.getByText('software')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'All' })).toHaveFocus(),
    );
    // Back leaves Books entirely: the reset added no entry.
    await act(() => router.navigate(-1));
    expect(router.state.location.pathname).toBe('/');
  });

  it('never advertises an unknown or inapplicable filter as applied', async () => {
    mount('?seg=invoices&status=bogus&nodoc=1');
    await screen.findByText('No invoices yet');
    expect(screen.queryByRole('group', { name: 'Active filters' })).toBeNull();
  });

  it('Invoices: the shared status filter is summarized', async () => {
    mount('?seg=invoices&status=corrected');
    await screen.findByText('No invoices yet');
    expect(bar()).toHaveTextContent('Showing 0 of 0 invoices · Corrected');
  });

  it('Documents: dstatus + search are summarized', async () => {
    mount('?seg=documents&dstatus=error&q=Fixture');
    await screen.findByText('fixture.pdf');
    expect(bar()).toHaveTextContent(
      'Showing 1 of 2 documents · Errors · Search “Fixture”',
    );
  });

  it('a failed list still shows the restrictions and Reset (no counts)', async () => {
    vi.mocked(getDocuments).mockRejectedValue(new Error('503'));
    const router = mount('?seg=documents&dstatus=error');
    await screen.findByRole('button', { name: 'Retry' });
    expect(bar()).toHaveTextContent('Filtered by: Errors');
    await userEvent.click(reset());
    await waitFor(() =>
      expect(router.state.location.search).toBe('?seg=documents'),
    );
  });

  it('No document is not claimed as applied while the archive failed without data', async () => {
    vi.mocked(getDocuments).mockRejectedValue(new Error('503'));
    mount('?nodoc=1');
    await screen.findByText('software');
    await waitFor(() =>
      expect(bar()).toHaveTextContent(
        'No document (not applied: documents failed to load)',
      ),
    );
  });

  it('a very long search shows a bounded excerpt, full value in the field', async () => {
    const long = 'fixture'.repeat(30);
    mount(`?q=${long}`);
    await screen.findByText(/^No expenses match “/);
    const excerpt = within(bar()).getByTitle(long);
    expect(excerpt.textContent!.length).toBeLessThan(45);
    expect(screen.getByRole('searchbox')).toHaveValue(long);
  });

  it('Credit notes: search is the only restriction; Clear search', async () => {
    const router = mount('?seg=credit-notes&q=zzz');
    await screen.findByText('No credit notes yet');
    expect(bar()).toHaveTextContent(
      'Showing 0 of 0 credit notes · Search “zzz”',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    await waitFor(() =>
      expect(router.state.location.search).toBe('?seg=credit-notes'),
    );
  });
});
