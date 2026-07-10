import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { BooksScreen } from './BooksScreen';

vi.mock('../api', async (io) => ({
  ...(await io<typeof import('../api')>()),
  getExpenses: vi.fn().mockResolvedValue([]),
  getInvoices: vi.fn().mockResolvedValue([]),
  getEntities: vi.fn().mockResolvedValue([]),
  getDocuments: vi.fn().mockResolvedValue([]),
  listCreditNotes: vi.fn().mockResolvedValue([]),
  getCategories: vi.fn().mockResolvedValue([]),
}));

function mount(url = '/books') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(
    [{ path: '/books', element: <BooksScreen /> }],
    {
      initialEntries: [url],
    },
  );
  const view = render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { ...view, router };
}

describe('BooksScreen', () => {
  it('defaults to Expenses and switches segments via ?seg=', async () => {
    mount();
    expect(
      await screen.findByRole('heading', { name: 'Books' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Expenses' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await userEvent.click(screen.getByRole('tab', { name: 'Documents' }));
    expect(await screen.findByText('No documents match')).toBeInTheDocument();
  });

  it('accepts the legacy ?tab= alias', async () => {
    mount('/books?tab=credit-notes');
    expect(
      await screen.findByRole('link', { name: 'New credit note' }),
    ).toBeInTheDocument();
  });

  it('switching segments preserves ?q= but drops segment-specific filters', async () => {
    const { router } = mount('/books?seg=expenses&q=acme&status=draft');
    await screen.findByRole('heading', { name: 'Books' });
    await userEvent.click(screen.getByRole('tab', { name: 'Invoices' }));
    // q survives in the search box; status chip resets to All:
    expect(screen.getByDisplayValue('acme')).toBeInTheDocument();
    expect(await screen.findByText('No invoices match')).toBeInTheDocument();
    // useSeg round-trip (P06 Task 3): ?seg= updated, ?q= PRESERVED, the
    // segment-scoped params (status/nodoc/dstatus) and any ?tab= dropped.
    const search = new URLSearchParams(router.state.location.search);
    expect(search.get('seg')).toBe('invoices');
    expect(search.get('q')).toBe('acme');
    expect(search.get('status')).toBeNull();
    expect(search.get('nodoc')).toBeNull();
    expect(search.get('dstatus')).toBeNull();
    expect(search.get('tab')).toBeNull();
  });

  it('the + button opens the create menu', async () => {
    mount();
    await userEvent.click(
      await screen.findByRole('button', { name: 'Add to the books' }),
    );
    expect(await screen.findByText('New expense')).toBeInTheDocument();
    expect(screen.getByText('Upload a document')).toBeInTheDocument();
  });
});
