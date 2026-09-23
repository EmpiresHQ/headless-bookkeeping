import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppToaster } from '../ui/toast';
import { ExpenseScreen } from './ExpenseScreen';

vi.mock('../api', async (io) => ({
  ...(await io<typeof import('../api')>()),
  getExpense: vi.fn(),
  getExpenses: vi.fn(),
  getEntities: vi.fn(),
  getDocuments: vi.fn(),
  listApprovals: vi.fn(),
  getCategories: vi.fn(),
  listAttachableDocuments: vi.fn(),
  attachExpenseDocument: vi.fn(),
}));
import {
  attachExpenseDocument,
  getCategories,
  getDocuments,
  getEntities,
  getExpense,
  getExpenses,
  listApprovals,
  listAttachableDocuments,
} from '../api';
import { UnsavedChangesProvider } from '../lib/unsavedChanges';

/** Issue #248: a "Receipt coming later" expense, posted from a bank line. */
const DETAIL = {
  id: 12,
  document_id: null as number | null,
  supplier_id: null,
  category: 'software',
  gross_amount: 12300,
  vat_amount: 2218,
  currency: 'EUR',
  tax_point_date: '2026-06-25',
  status: 'posted',
  supplier_invoice_number: null,
  ai_confidence: null,
  claimant_id: null,
  created_at: 1750830000,
};

const DOC = {
  id: 31,
  filename: 'late-receipt.pdf',
  mime_type: 'application/pdf',
  size_bytes: 10,
  status: 'processed',
  processing_since: null,
  created_at: 1750900000,
};

const CANDIDATE = {
  id: 44,
  filename: 'telegram-photo.jpg',
  mime_type: 'image/jpeg',
  status: 'needs_triage' as const,
  created_at: 1750900000,
  reason: 'Possible duplicate of expense #12',
};

let server: { documentId: number | null; getFails: number };

function mount(detail: Partial<typeof DETAIL> = {}) {
  server = { documentId: detail.document_id ?? null, getFails: 0 };
  vi.mocked(getExpense).mockImplementation(async () => {
    if (server.getFails > 0) {
      server.getFails -= 1;
      throw new Error('503 Service Unavailable: verify down');
    }
    return { ...DETAIL, ...detail, document_id: server.documentId } as never;
  });
  vi.mocked(getExpenses).mockResolvedValue([
    { ...DETAIL, reconciled: true },
  ] as never);
  vi.mocked(getEntities).mockResolvedValue([] as never);
  vi.mocked(getDocuments).mockImplementation(
    async () =>
      (server.documentId != null
        ? [{ ...DOC, id: server.documentId, expense_id: 12 }]
        : []) as never,
  );
  vi.mocked(listApprovals).mockResolvedValue([] as never);
  vi.mocked(getCategories).mockResolvedValue([] as never);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <UnsavedChangesProvider onUnauthorized={() => undefined}>
        <MemoryRouter initialEntries={['/books/expenses/12']}>
          <AppToaster />
          <Routes>
            <Route path="/books/expenses/:id" element={<ExpenseScreen />} />
          </Routes>
        </MemoryRouter>
      </UnsavedChangesProvider>
    </QueryClientProvider>,
  );
}

const attachOk = (documentId: number, filename: string) =>
  vi.mocked(attachExpenseDocument).mockImplementationOnce(async () => {
    server.documentId = documentId;
    return {
      outcome: 'attached',
      expense: { ...DETAIL, document_id: documentId },
      document: { ...DOC, id: documentId, filename },
    } as never;
  });

const file = () =>
  new File(['%PDF late'], 'late-receipt.pdf', { type: 'application/pdf' });

// fireEvent, like the other sheet tests: vaul's drawer calls
// setPointerCapture on pointer events, which jsdom does not implement.
const pick = (sheet: HTMLElement) =>
  fireEvent.change(within(sheet).getByLabelText('Receipt file'), {
    target: { files: [file()] },
  });

async function openSheet() {
  fireEvent.click(
    await screen.findByRole('button', { name: /Attach receipt…/ }),
  );
  return screen.findByRole('dialog');
}

beforeEach(() => {
  vi.mocked(attachExpenseDocument).mockReset();
  vi.mocked(listAttachableDocuments).mockReset();
});

describe('Attach a late receipt (issue #248)', () => {
  it('an expense WITH a source offers no attach', async () => {
    mount({ document_id: 31 });
    expect(
      await screen.findByRole('link', { name: /late-receipt\.pdf/ }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Attach receipt/ })).toBeNull();
  });

  it('uploads a file, confirms by re-reading the SAME expense, then shows the linked document', async () => {
    mount();
    const sheet = await openSheet();
    const attachBtn = within(sheet).getByRole('button', {
      name: 'Upload & attach',
    });
    expect(attachBtn).toBeDisabled();

    pick(sheet);
    expect(
      within(sheet).getByText('Attach “late-receipt.pdf” to this expense'),
    ).toBeInTheDocument();
    expect(
      within(sheet).getByText(/the posted entry is not changed/),
    ).toBeInTheDocument();

    attachOk(31, 'late-receipt.pdf');
    fireEvent.click(attachBtn);

    await waitFor(() =>
      expect(attachExpenseDocument).toHaveBeenCalledWith(12, {
        file: expect.any(File),
      }),
    );
    expect(
      await screen.findByText('Attached · late-receipt.pdf'),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole('link', { name: /late-receipt\.pdf/ }),
    ).toHaveAttribute('href', '/books/documents/31');
    expect(attachExpenseDocument).toHaveBeenCalledTimes(1);
  });

  it('a failed attach keeps the chosen file and the server reason; a retry succeeds', async () => {
    mount();
    const sheet = await openSheet();
    pick(sheet);
    vi.mocked(attachExpenseDocument).mockRejectedValueOnce(
      new Error('503 Service Unavailable: storage down'),
    );
    fireEvent.click(
      within(sheet).getByRole('button', { name: 'Upload & attach' }),
    );

    const alert = await within(sheet).findByRole('alert');
    expect(alert).toHaveTextContent('Not attached');
    expect(alert).toHaveTextContent('storage down');
    expect(within(sheet).getByText('late-receipt.pdf')).toBeInTheDocument();
    expect(screen.queryByText(/Attached ·/)).toBeNull();

    attachOk(31, 'late-receipt.pdf');
    fireEvent.click(
      within(sheet).getByRole('button', { name: 'Upload & attach' }),
    );
    expect(
      await screen.findByText('Attached · late-receipt.pdf'),
    ).toBeInTheDocument();
  });

  it('picks a server-listed document; a 409 keeps the selection and the reason', async () => {
    mount();
    vi.mocked(listAttachableDocuments).mockResolvedValue([CANDIDATE]);
    const sheet = await openSheet();
    fireEvent.click(within(sheet).getByRole('tab', { name: 'From Documents' }));
    const option = await within(sheet).findByRole('radio', {
      name: /telegram-photo\.jpg/,
    });
    expect(option).toHaveTextContent('Needs review');
    expect(option).toHaveTextContent('Possible duplicate of expense #12');
    fireEvent.click(option);

    vi.mocked(attachExpenseDocument).mockRejectedValueOnce(
      new Error(
        '409 Conflict: Document 44 is being processed or changed right now — nothing was attached.',
      ),
    );
    fireEvent.click(
      within(sheet).getByRole('button', { name: 'Attach document' }),
    );
    expect(attachExpenseDocument).toHaveBeenCalledWith(12, { documentId: 44 });
    expect(await within(sheet).findByRole('alert')).toHaveTextContent(
      'being processed',
    );
    await waitFor(() =>
      expect(listAttachableDocuments).toHaveBeenCalledTimes(2),
    );
    expect(
      within(sheet).getByRole('radio', { name: /telegram-photo\.jpg/ }),
    ).toHaveAttribute('aria-checked', 'true');

    attachOk(44, 'telegram-photo.jpg');
    fireEvent.click(
      within(sheet).getByRole('button', { name: 'Attach document' }),
    );
    expect(
      await screen.findByText('Attached · telegram-photo.jpg'),
    ).toBeInTheDocument();
  });

  it('a document the server stops offering is flagged and cannot be attached', async () => {
    mount();
    vi.mocked(listAttachableDocuments)
      .mockResolvedValueOnce([CANDIDATE])
      .mockResolvedValueOnce([]);
    const sheet = await openSheet();
    fireEvent.click(within(sheet).getByRole('tab', { name: 'From Documents' }));
    fireEvent.click(
      await within(sheet).findByRole('radio', { name: /telegram-photo/ }),
    );
    vi.mocked(attachExpenseDocument).mockRejectedValueOnce(
      new Error(
        '409 Conflict: Document #44 cannot be attached: it is the evidence for allowance #3.',
      ),
    );
    fireEvent.click(
      within(sheet).getByRole('button', { name: 'Attach document' }),
    );
    expect(await within(sheet).findByRole('alert')).toHaveTextContent(
      'evidence for allowance #3',
    );
    expect(
      await within(sheet).findByText(
        /“telegram-photo\.jpg” is no longer offered/,
      ),
    ).toBeInTheDocument();
    expect(
      within(sheet).getByText('Attach “telegram-photo.jpg” to this expense'),
    ).toBeInTheDocument();
    expect(
      within(sheet).getByRole('button', { name: 'Attach document' }),
    ).toBeDisabled();
  });

  it('shows an honest empty list and a retryable load error', async () => {
    mount();
    vi.mocked(listAttachableDocuments)
      .mockRejectedValueOnce(new Error('500 Internal Server Error: boom'))
      .mockResolvedValueOnce([]);
    const sheet = await openSheet();
    fireEvent.click(within(sheet).getByRole('tab', { name: 'From Documents' }));
    expect(
      await within(sheet).findByText(/Could not load documents/),
    ).toBeInTheDocument();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Retry' }));
    expect(
      await within(sheet).findByText(/No unassigned documents can be attached/),
    ).toBeInTheDocument();
  });

  it('an attach that cannot be re-read is "not yet confirmed" — no success, no second attach, re-check confirms', async () => {
    mount();
    const sheet = await openSheet();
    pick(sheet);
    vi.mocked(attachExpenseDocument).mockImplementationOnce(async () => {
      server.documentId = 31;
      server.getFails = 1;
      return {
        outcome: 'attached',
        expense: { ...DETAIL, document_id: 31 },
        document: DOC,
      } as never;
    });
    fireEvent.click(
      within(sheet).getByRole('button', { name: 'Upload & attach' }),
    );

    // The outcome's own status (the busy button also owns an empty one).
    const status = (
      await within(sheet).findByText('Attached — not yet confirmed')
    ).closest('[role="status"]');
    expect(status).toHaveTextContent('Attached — not yet confirmed');
    expect(status).toHaveTextContent('verify down');
    expect(
      within(sheet).queryByRole('button', { name: 'Upload & attach' }),
    ).toBeNull();
    expect(screen.queryByText(/Attached ·/)).toBeNull();

    fireEvent.click(
      within(sheet).getByRole('button', { name: 'Check the expense again' }),
    );
    expect(
      await screen.findByText('Attached · late-receipt.pdf'),
    ).toBeInTheDocument();
    expect(attachExpenseDocument).toHaveBeenCalledTimes(1);
  });

  it('a source mismatch after an accepted write stays "not yet confirmed" — never "Not attached"', async () => {
    mount();
    const sheet = await openSheet();
    pick(sheet);
    // The server accepted it, but the re-read does not (yet) show it.
    vi.mocked(attachExpenseDocument).mockResolvedValueOnce({
      outcome: 'attached',
      expense: { ...DETAIL, document_id: 31 },
      document: DOC,
    } as never);
    fireEvent.click(
      within(sheet).getByRole('button', { name: 'Upload & attach' }),
    );

    expect(
      (await within(sheet).findByText(/does not show it yet/)).closest(
        '[role="status"]',
      ),
    ).toHaveTextContent('does not show it yet');
    expect(within(sheet).queryByRole('alert')).toBeNull();
    expect(
      within(sheet).queryByRole('button', { name: 'Upload & attach' }),
    ).toBeNull();

    server.documentId = 31;
    fireEvent.click(
      within(sheet).getByRole('button', { name: 'Check the expense again' }),
    );
    expect(
      await screen.findByText('Attached · late-receipt.pdf'),
    ).toBeInTheDocument();
    expect(attachExpenseDocument).toHaveBeenCalledTimes(1);
  });

  it('unsaved guard (#250): a chosen file asks before closing; once the server accepted it, closing does not', async () => {
    mount();
    const sheet = await openSheet();
    pick(sheet);
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(
      await screen.findByRole('button', { name: 'Keep editing' }),
    );
    expect(within(sheet).getByText('late-receipt.pdf')).toBeInTheDocument();

    // Accepted by the server, re-read not confirming yet: the file is on the
    // server — closing loses the re-check view, not the operator's input.
    vi.mocked(attachExpenseDocument).mockResolvedValueOnce({
      outcome: 'attached',
      expense: { ...DETAIL, document_id: 31 },
      document: DOC,
    } as never);
    fireEvent.click(
      within(sheet).getByRole('button', { name: 'Upload & attach' }),
    );
    await within(sheet).findByRole('status');
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it.each([
    ['draft', /change it with Edit draft…/],
    ['pending', /awaiting approval/],
    ['posted', /use Correct… for that/],
    ['reversed', /already corrected and can’t be corrected again/],
  ])(
    'a VAT-0 ("no receipt") %s expense says where VAT can change',
    async (status, hint) => {
      mount({ vat_amount: 0, status });
      const sheet = await openSheet();
      expect(within(sheet).getByText(hint)).toBeInTheDocument();
    },
  );
});
