import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api', async (original) => ({
  ...(await original<typeof import('../api')>()),
  getNeedsTriageItems: vi.fn(),
  getPendingApprovals: vi.fn(),
  getExpenses: vi.fn(),
  getInvoices: vi.fn(),
  getEntities: vi.fn(),
  getReportingPeriods: vi.fn(),
  fetchDocumentPreviewObjectUrl: vi.fn(),
  completeDocument: vi.fn(),
}));
vi.mock('./pdfjs', () => ({
  loadPdfJs: () => new Promise(() => undefined),
  pdfDocumentOptions: () => ({}),
}));
import * as api from '../api';
import { InboxScreen } from './InboxScreen';
import { UnsavedChangesProvider } from '../lib/unsavedChanges';

let documents: api.NeedsTriageItem[];
function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const router = createMemoryRouter(
    [
      { path: '/inbox', element: <InboxScreen /> },
      { path: '/inbox/doc/:id', element: <p>Document detail</p> },
    ],
    { initialEntries: ['/inbox'] },
  );
  render(
    <QueryClientProvider client={client}>
      <UnsavedChangesProvider onUnauthorized={() => undefined}>
        <RouterProvider router={router} />
      </UnsavedChangesProvider>
    </QueryClientProvider>,
  );
  return { router, client };
}
const checkbox = (name: string) =>
  screen.getByRole('checkbox', { name: `Select ${name}.pdf` });
async function confirmArchive() {
  fireEvent.click(screen.getByRole('button', { name: /Archive selected/ }));
  const dialog = await screen.findByRole('alertdialog');
  fireEvent.click(
    within(dialog).getByRole('button', { name: 'Archive documents' }),
  );
}

describe('Inbox bulk archive', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    documents = ['personal', 'receipt', 'newsletter'].map((name, i) => ({
      id: i + 1,
      filename: `${name}.pdf`,
      created_at: 1700000000 + i,
      reason: 'Review',
      reason_type: 'classification_failed',
    }));
    vi.mocked(api.getNeedsTriageItems).mockImplementation(async () => [
      ...documents,
    ]);
    vi.mocked(api.getPendingApprovals).mockResolvedValue([
      {
        id: 99,
        object_type: 'expense',
        object_id: 99,
        status: 'pending',
        requested_by: 'system:policy',
        approved_by: null,
        rejected_reason: null,
        policy_reason: 'Review',
        superseded_by: null,
        created_at: 1700000000,
        resolved_at: null,
      },
    ]);
    vi.mocked(api.getExpenses).mockResolvedValue([]);
    vi.mocked(api.getInvoices).mockResolvedValue([]);
    vi.mocked(api.getEntities).mockResolvedValue([]);
    vi.mocked(api.getReportingPeriods).mockResolvedValue([]);
    vi.mocked(api.fetchDocumentPreviewObjectUrl).mockResolvedValue(
      'blob:preview',
    );
    vi.mocked(api.completeDocument).mockImplementation(async (id) => {
      documents = documents.filter((doc) => doc.id !== id);
      return { id, status: 'processed' };
    });
  });

  it('keeps selection through preview and archives only selected documents, never approvals', async () => {
    const { router } = setup();
    await screen.findByText('personal.pdf');
    fireEvent.click(checkbox('personal'));
    expect(router.state.location.pathname).toBe('/inbox');
    const row = screen.getByRole('link', {
      name: /personal.pdf/,
    }).parentElement!;
    fireEvent.click(
      await within(row).findByRole('button', { name: 'Open document preview' }),
    );
    const preview = await screen.findByRole('dialog', {
      name: 'Document preview',
    });
    fireEvent.click(
      within(preview).getByRole('button', { name: 'Close preview' }),
    );
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
    );
    expect(checkbox('personal')).toBeChecked();
    fireEvent.click(checkbox('newsletter'));
    await confirmArchive();
    await screen.findByText('2 documents archived without booking.');
    expect(
      vi
        .mocked(api.completeDocument)
        .mock.calls.map(([id]) => id)
        .sort(),
    ).toEqual([1, 3]);
    expect(screen.queryByText('personal.pdf')).not.toBeInTheDocument();
    expect(screen.getByText('receipt.pdf')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Expense/ })).toBeInTheDocument();
  });

  it('selects only visible results and preserves explicitly selected hidden documents', async () => {
    setup();
    await screen.findByText('personal.pdf');
    fireEvent.click(checkbox('personal'));
    fireEvent.change(screen.getByRole('searchbox'), {
      target: { value: 'newsletter' },
    });
    await waitFor(() =>
      expect(screen.queryByText('personal.pdf')).not.toBeInTheDocument(),
    );
    expect(screen.getByText(/1 hidden by filters/)).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'Select all visible documents' }),
    );
    await confirmArchive();
    await screen.findByText('2 documents archived without booking.');
    expect(
      vi
        .mocked(api.completeDocument)
        .mock.calls.map(([id]) => id)
        .sort(),
    ).toEqual([1, 3]);
  });

  it('retains failed rows selected and retries only those after partial success', async () => {
    vi.mocked(api.completeDocument).mockImplementation(async (id) => {
      if (id === 2) throw new Error('Server unavailable');
      documents = documents.filter((doc) => doc.id !== id);
      return { id, status: 'processed' };
    });
    setup();
    await screen.findByText('personal.pdf');
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'Select all visible documents' }),
    );
    await confirmArchive();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'receipt.pdf: Server unavailable',
    );
    expect(checkbox('receipt')).toBeChecked();
    expect(
      screen.getByRole('button', { name: 'Archive selected · 1' }),
    ).toBeInTheDocument();
    vi.mocked(api.completeDocument)
      .mockClear()
      .mockResolvedValue({ id: 2, status: 'processed' });
    await confirmArchive();
    await waitFor(() => expect(api.completeDocument).toHaveBeenCalledTimes(1));
    expect(api.completeDocument).toHaveBeenCalledWith(2);
  });

  it('does not submit on cancel, and locks the batch against double confirmation', async () => {
    let finish!: () => void;
    vi.mocked(api.completeDocument).mockImplementation(async (id) => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      documents = documents.filter((doc) => doc.id !== id);
      return { id, status: 'processed' };
    });
    setup();
    await screen.findByText('personal.pdf');
    fireEvent.click(checkbox('personal'));
    fireEvent.click(screen.getByRole('button', { name: /Archive selected/ }));
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Cancel',
      }),
    );
    expect(api.completeDocument).not.toHaveBeenCalled();
    await confirmArchive();
    const dialog = screen.getByRole('alertdialog');
    const confirm = within(dialog).getByRole('button', {
      name: 'Archive documents',
    });
    expect(confirm).toBeDisabled();
    fireEvent.click(confirm);
    expect(api.completeDocument).toHaveBeenCalledTimes(1);
    await act(async () => finish());
    await screen.findByText('1 document archived without booking.');
  });
});
