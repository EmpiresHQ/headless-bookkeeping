import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  render,
  screen,
  fireEvent,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { BooksScreen } from './BooksScreen';
import { UnsavedChangesProvider } from '../lib/unsavedChanges';

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
      <UnsavedChangesProvider onUnauthorized={() => undefined}>
        <RouterProvider router={router} />
      </UnsavedChangesProvider>
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
    expect(screen.getByRole('radio', { name: 'Expenses' })).toBeChecked();
    await userEvent.click(screen.getByRole('radio', { name: 'Documents' }));
    expect(await screen.findByText('No documents yet')).toBeInTheDocument();
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
    await userEvent.click(screen.getByRole('radio', { name: 'Invoices' }));
    // q survives in the search box; status chip resets to All:
    expect(screen.getByDisplayValue('acme')).toBeInTheDocument();
    // Nothing loaded at all: the initial empty, not a failed search (#280).
    expect(await screen.findByText('No invoices yet')).toBeInTheDocument();
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

  it('New expense sheet resets across open/close/reopen', async () => {
    mount();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Add to the books' }),
    );
    fireEvent.click(await screen.findByText('New expense'));
    fireEvent.change(await screen.findByLabelText('Gross (€)'), {
      target: { value: '48.20' },
    });
    fireEvent.keyDown(document, { key: 'Escape' });
    // Dirty: the guard asks first (issue #250) — discard it.
    fireEvent.click(await screen.findByRole('button', { name: 'Discard' }));
    await waitFor(() =>
      expect(screen.queryByLabelText('Gross (€)')).toBeNull(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add to the books' }));
    fireEvent.click(await screen.findByText('New expense'));
    expect(await screen.findByLabelText('Gross (€)')).toHaveValue('');
  });

  it('New invoice sheet resets across open/close/reopen', async () => {
    mount();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Add to the books' }),
    );
    fireEvent.click(await screen.findByText('New sales invoice'));
    fireEvent.change(await screen.findByLabelText('Invoice number'), {
      target: { value: 'INV-HALF' },
    });
    fireEvent.keyDown(document, { key: 'Escape' });
    // Dirty: the guard asks first (issue #250) — discard it.
    fireEvent.click(await screen.findByRole('button', { name: 'Discard' }));
    await waitFor(() =>
      expect(screen.queryByLabelText('Invoice number')).toBeNull(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add to the books' }));
    fireEvent.click(await screen.findByText('New sales invoice'));
    expect(await screen.findByLabelText('Invoice number')).toHaveValue('');
  });

  it('Upload sheet resets its file selection across open/close/reopen', async () => {
    mount();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Add to the books' }),
    );
    fireEvent.click(await screen.findByText('Upload a document'));
    const fileInput = await screen.findByLabelText('File');
    const file = new File(['x'], 'half-typed.pdf', {
      type: 'application/pdf',
    });
    fireEvent.change(fileInput, { target: { files: [file] } });
    expect(screen.getByRole('button', { name: /Upload/ })).not.toBeDisabled();
    fireEvent.keyDown(document, { key: 'Escape' });
    // Dirty: the guard asks first (issue #250) — discard it.
    fireEvent.click(await screen.findByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(screen.queryByLabelText('File')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Add to the books' }));
    fireEvent.click(await screen.findByText('Upload a document'));
    expect(
      await screen.findByRole('button', { name: /Upload/ }),
    ).toBeDisabled();
  });
  it('issue #268: keyboard menu → New expense handoff; closing returns to "Add to the books", the menu never steals late', async () => {
    const user = userEvent.setup();
    mount();
    const add = await screen.findByRole('button', {
      name: 'Add to the books',
    });
    add.focus();
    await user.keyboard('{Enter}');
    const menu = await screen.findByRole('dialog', {
      name: 'Add to the books',
    });
    expect(document.activeElement).toBe(
      within(menu).getByRole('button', { name: 'Close' }),
    );
    within(menu)
      .getByRole('button', { name: /New expense/ })
      .focus();
    await user.keyboard('{Enter}');
    const form = await screen.findByRole('dialog', { name: 'New expense' });
    const formClose = within(form).getByRole('button', { name: 'Close' });
    await waitFor(() =>
      expect(
        screen.queryByRole('dialog', { name: 'Add to the books' }),
      ).toBeNull(),
    );
    // The menu's exit has run its close-autofocus: focus stayed in the form.
    await new Promise((r) => setTimeout(r, 20));
    expect(document.activeElement).toBe(formClose);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(document.activeElement).toBe(add));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
