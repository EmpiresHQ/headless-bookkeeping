import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
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
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[url]}>
        <BooksScreen />
      </MemoryRouter>
    </QueryClientProvider>,
  );
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
    mount('/books?seg=expenses&q=telia&status=draft');
    await screen.findByRole('heading', { name: 'Books' });
    await userEvent.click(screen.getByRole('tab', { name: 'Invoices' }));
    // q survives in the search box; status chip resets to All:
    expect(screen.getByDisplayValue('telia')).toBeInTheDocument();
    expect(await screen.findByText('No invoices match')).toBeInTheDocument();
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
