import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The chosen file's local preview (#293) is not under test here: pdf.js
// never settles, so no viewer state or control joins these flows.
vi.mock('../inbox/pdfjs', () => ({
  loadPdfJs: () => new Promise(() => undefined),
  pdfDocumentOptions: () => ({}),
}));

vi.mock('../api', async (io) => ({
  ...(await io<typeof import('../api')>()),
  uploadDocument: vi.fn(),
  triageDocument: vi.fn(),
  getEntities: vi.fn(),
  getNeedsTriageItems: vi.fn(),
  getExpense: vi.fn(),
  getBankImportStatus: vi.fn(),
}));
import {
  getBankImportStatus,
  getEntities,
  getExpense,
  getNeedsTriageItems,
  triageDocument,
  uploadDocument,
  type DocumentRow,
  type Entity,
} from '../api';
import { UnauthorizedError, setToken } from '../auth';
import { readImportPointer, writeImportPointer } from '../bank/importResume';
import { ImportScreen } from '../bank/ImportScreen';
import { UnsavedChangesProvider } from '../lib/unsavedChanges';
import { AppToaster } from '../ui/toast';
import { UploadDocumentSheet } from './UploadDocumentSheet';

const MARI: Entity = {
  id: 5,
  role: 'employee',
  country: 'EE',
  name: 'Mari Maasikas',
  goods_vs_services: null,
  tax_status: null,
} as Entity;
const JAAN: Entity = { ...MARI, id: 8, role: 'director', name: 'Jaan Tamm' };
const SUPPLIER: Entity = {
  ...MARI,
  id: 3,
  role: 'supplier',
  name: 'Telia Eesti AS',
};

function doc(over: Partial<DocumentRow> = {}): DocumentRow {
  return {
    id: 77,
    filename: 'r.pdf',
    mime_type: 'application/pdf',
    size_bytes: 1,
    status: 'pending',
    processing_since: null,
    created_at: 1,
    claimant_id: null,
    ...over,
  };
}

const queued = (id: number) => ({
  id,
  filename: 'r.pdf',
  created_at: 1,
  reason: 'Unknown supplier',
  reason_type: 'supplier_unresolved' as const,
});

const DEST = [
  '/books/expenses/:id',
  '/books/invoices/:id',
  '/books/documents/:id',
  '/inbox/doc/:id',
];

function mount(at = '/books?seg=documents') {
  const onUnauthorized = vi.fn();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(
    [
      {
        path: at.split('?')[0],
        element: <UploadDocumentSheet open onOpenChange={() => undefined} />,
      },
      ...DEST.map((path) => ({ path, element: <p>landed {path}</p> })),
      { path: '/bank/import', element: <ImportScreen /> },
      { path: '/elsewhere', element: <p>elsewhere</p> },
    ],
    { initialEntries: [at] },
  );
  render(
    <QueryClientProvider client={qc}>
      <UnsavedChangesProvider onUnauthorized={onUnauthorized}>
        <AppToaster />
        <RouterProvider router={router} />
      </UnsavedChangesProvider>
    </QueryClientProvider>,
  );
  return { router, onUnauthorized, qc };
}

async function pick(payer?: string) {
  // The payer list must have loaded before anything can be sent.
  await screen.findByRole('option', { name: '— company paid —' });
  if (payer !== undefined) {
    fireEvent.change(await screen.findByLabelText('Paid by (claimant)'), {
      target: { value: payer },
    });
  }
  const file = new File(['x'], 'r.pdf', { type: 'application/pdf' });
  fireEvent.change(await screen.findByLabelText('File'), {
    target: { files: [file] },
  });
  return file;
}

const go = (name: string | RegExp = 'Upload & process') =>
  fireEvent.click(screen.getByRole('button', { name }));

const path = (r: ReturnType<typeof mount>['router']) =>
  r.state.location.pathname + r.state.location.search;

describe('UploadDocumentSheet (issue #258)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    setToken('test-token');
    vi.mocked(getEntities).mockResolvedValue([SUPPLIER, MARI, JAAN]);
    vi.mocked(getNeedsTriageItems).mockResolvedValue([]);
    vi.mocked(getBankImportStatus).mockImplementation(
      async (id: number) =>
        ({
          id,
          status: 'running',
          account_code: 'BANK_EUR',
          statement_id: null,
          error: null,
        }) as never,
    );
  });

  it('offers only employees/directors as the payer and sends the claimant', async () => {
    vi.mocked(uploadDocument).mockResolvedValue({
      document: doc({ claimant_id: 5 }),
      deduplicated: false,
    });
    vi.mocked(triageDocument).mockResolvedValue({
      kind: 'expense',
      document_id: 77,
      expense_id: 31,
    });
    const { router } = mount();
    await screen.findByRole('option', { name: 'Mari Maasikas' });
    const select = screen.getByLabelText('Paid by (claimant)');
    expect(
      within(select)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['— company paid —', 'Mari Maasikas', 'Jaan Tamm']);
    expect(screen.queryByText(/ADR/)).toBeNull();
    const file = await pick('5');
    go();
    await waitFor(() => expect(path(router)).toBe('/books/expenses/31'));
    expect(uploadDocument).toHaveBeenCalledWith(file, { claimantId: 5 });
    // The outcome also covers a receipt filed against an EXISTING expense:
    // the receipt never claims one was created, and nothing extra is read.
    expect(
      await screen.findByText(/here is the expense this document belongs to/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/created/i)).toBeNull();
    expect(getExpense).not.toHaveBeenCalled();
  });

  it("a started bank import becomes the tab's import: an older pointer never wins a plain return (#254)", async () => {
    writeImportPointer(3);
    vi.mocked(uploadDocument).mockResolvedValue({
      document: doc(),
      deduplicated: false,
    });
    vi.mocked(triageDocument).mockResolvedValue({
      kind: 'bank_statement',
      document_id: 77,
      job_id: 4,
    });
    const { router } = mount();
    await pick();
    go();
    await waitFor(() => expect(path(router)).toBe('/bank/import?job=4'));
    expect(
      await screen.findByText('Bank statement — import started'),
    ).toBeInTheDocument();
    expect(readImportPointer()).toBe(4);
    // A plain return to /bank/import resumes the job just started.
    await act(() => router.navigate('/elsewhere'));
    await act(() => router.navigate('/bank/import'));
    await waitFor(() => expect(path(router)).toBe('/bank/import?job=4'));
    expect(getBankImportStatus).toHaveBeenCalledWith(4);
    expect(getBankImportStatus).not.toHaveBeenCalledWith(3);
  });

  it('a known processed duplicate leaves the import pointer alone', async () => {
    writeImportPointer(3);
    vi.mocked(uploadDocument).mockResolvedValue({
      document: doc({ id: 19, status: 'processed' }),
      deduplicated: true,
    });
    const { router } = mount();
    await pick();
    go();
    await waitFor(() => expect(path(router)).toBe('/books/documents/19'));
    expect(readImportPointer()).toBe(3);
  });

  it('routes an invoice outcome to the invoice', async () => {
    vi.mocked(uploadDocument).mockResolvedValue({
      document: doc(),
      deduplicated: false,
    });
    vi.mocked(triageDocument).mockResolvedValue({
      kind: 'invoice',
      document_id: 77,
      invoice_id: 9,
    });
    const { router } = mount();
    await pick();
    go();
    await waitFor(() => expect(path(router)).toBe('/books/invoices/9'));
  });

  it('needs review (confirmed by the queue): opens the triage item as a SINGLE item returning to the Books segment', async () => {
    vi.mocked(uploadDocument).mockResolvedValue({
      document: doc(),
      deduplicated: false,
    });
    vi.mocked(triageDocument).mockImplementation(async () => {
      vi.mocked(getNeedsTriageItems).mockResolvedValue([queued(77)]);
      return { kind: 'unknown', document_id: 77, reason: 'Unknown supplier' };
    });
    const { router } = mount('/books?seg=documents');
    await pick();
    go();
    await waitFor(() => expect(path(router)).toBe('/inbox/doc/77'));
    const state = router.state.location.state as Record<string, unknown>;
    expect(state.hbkRun).toBeUndefined();
    expect((state.hbkOrigin as { href: string }).href).toBe(
      '/books?seg=documents',
    );
  });

  it('unknown but NOT in the queue: goes to the document without claiming it was already uploaded', async () => {
    vi.mocked(uploadDocument).mockResolvedValue({
      document: doc(),
      deduplicated: false,
    });
    vi.mocked(triageDocument).mockResolvedValue({
      kind: 'unknown',
      document_id: 77,
      reason: 'x',
    });
    const { router } = mount();
    await pick();
    go();
    await waitFor(() => expect(path(router)).toBe('/books/documents/77'));
    expect(
      await screen.findByText(/Processed without a result/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Already uploaded/)).toBeNull();
    expect(screen.queryByText(/nothing was processed again/)).toBeNull();
  });

  it('a known duplicate that was already processed is NOT processed again', async () => {
    vi.mocked(uploadDocument).mockResolvedValue({
      document: doc({ id: 19, status: 'processed' }),
      deduplicated: true,
    });
    const { router } = mount();
    await pick();
    go();
    await waitFor(() => expect(path(router)).toBe('/books/documents/19'));
    expect(triageDocument).not.toHaveBeenCalled();
    expect(
      await screen.findByText(
        'Already uploaded as document #19 — nothing was processed again',
      ),
    ).toBeInTheDocument();
  });

  it('a known duplicate still pending is processed (once)', async () => {
    vi.mocked(uploadDocument).mockResolvedValue({
      document: doc({ id: 19, status: 'pending' }),
      deduplicated: true,
    });
    vi.mocked(triageDocument).mockResolvedValue({
      kind: 'invoice',
      document_id: 19,
      invoice_id: 2,
    });
    const { router } = mount();
    await pick();
    go();
    await waitFor(() => expect(path(router)).toBe('/books/invoices/2'));
    expect(triageDocument).toHaveBeenCalledTimes(1);
  });

  it('a known duplicate awaiting review: confirmed by the queue, never processed — even when the queue read fails', async () => {
    vi.mocked(uploadDocument).mockResolvedValue({
      document: doc({ id: 19, status: 'needs_triage' }),
      deduplicated: true,
    });
    vi.mocked(getNeedsTriageItems).mockRejectedValueOnce(
      new Error('503 Service Unavailable'),
    );
    const { router } = mount('/inbox');
    await pick();
    go();
    const retry = await screen.findByRole('button', { name: 'Reload result' });
    expect(screen.getByText(/does not upload or process/)).toBeInTheDocument();
    vi.mocked(getNeedsTriageItems).mockResolvedValue([queued(19)]);
    fireEvent.click(retry);
    await waitFor(() => expect(path(router)).toBe('/inbox/doc/19'));
    expect(uploadDocument).toHaveBeenCalledTimes(1);
    expect(triageDocument).not.toHaveBeenCalled();
  });

  it('a duplicate whose stored payer differs stops and says so — the new choice is never claimed as stored', async () => {
    vi.mocked(uploadDocument).mockResolvedValue({
      document: doc({ id: 19, status: 'pending', claimant_id: 8 }),
      deduplicated: true,
    });
    vi.mocked(triageDocument).mockResolvedValue({
      kind: 'invoice',
      document_id: 19,
      invoice_id: 2,
    });
    const { router } = mount();
    await pick('5');
    go();
    const cont = await screen.findByRole('button', {
      name: 'Continue with document #19',
    });
    expect(screen.getByText(/stored as paid by Jaan Tamm/).textContent).toMatch(
      /your choice \(\s*paid by Mari Maasikas\) was not applied/,
    );
    expect(triageDocument).not.toHaveBeenCalled();
    // The payer is fixed with the uploaded file.
    expect(screen.getByLabelText('Paid by (claimant)')).toBeDisabled();
    fireEvent.click(cont);
    await waitFor(() => expect(path(router)).toBe('/books/invoices/2'));
    expect(uploadDocument).toHaveBeenCalledTimes(1);
    expect(triageDocument).toHaveBeenCalledTimes(1);
  });

  it('a duplicate whose stored payer is not reported is unknown, not company paid', async () => {
    const { claimant_id: _omit, ...noPayer } = doc({
      id: 19,
      status: 'processed',
    });
    void _omit;
    vi.mocked(uploadDocument).mockResolvedValue({
      document: noPayer,
      deduplicated: true,
    });
    mount();
    await pick();
    go();
    expect(
      await screen.findByText(/stored as an unconfirmed payer/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Continue with document #19' }),
    ).toBeInTheDocument();
  });

  it('partial success: processing failed after the upload — retry only re-runs processing (#251)', async () => {
    vi.mocked(uploadDocument).mockResolvedValue({
      document: doc({ id: 32 }),
      deduplicated: false,
    });
    vi.mocked(triageDocument)
      .mockRejectedValueOnce(new Error('503 Service Unavailable'))
      .mockResolvedValueOnce({
        kind: 'expense',
        document_id: 32,
        expense_id: 31,
      });
    const { router } = mount();
    await pick('5');
    go();
    const retry = await screen.findByRole('button', {
      name: 'Retry processing',
    });
    expect(screen.getByRole('link', { name: 'document #32' })).toHaveAttribute(
      'href',
      '/books/documents/32',
    );
    expect(screen.getByLabelText('Paid by (claimant)')).toHaveValue('5');
    fireEvent.click(retry);
    await waitFor(() => expect(path(router)).toBe('/books/expenses/31'));
    expect(uploadDocument).toHaveBeenCalledTimes(1);
    expect(triageDocument).toHaveBeenCalledTimes(2);
    expect(triageDocument).toHaveBeenLastCalledWith(32);
  });

  it('processed, but the result read failed: retry re-reads, never processes again', async () => {
    vi.mocked(uploadDocument).mockResolvedValue({
      document: doc(),
      deduplicated: false,
    });
    vi.mocked(triageDocument).mockResolvedValue({
      kind: 'unknown',
      document_id: 77,
      reason: 'x',
    });
    vi.mocked(getNeedsTriageItems).mockRejectedValueOnce(
      new Error('502 Bad Gateway'),
    );
    const { router } = mount();
    await pick();
    go();
    const reload = await screen.findByRole('button', { name: 'Reload result' });
    expect(screen.getByText(/and was processed/)).toBeInTheDocument();
    vi.mocked(getNeedsTriageItems).mockResolvedValue([queued(77)]);
    fireEvent.click(reload);
    await waitFor(() => expect(path(router)).toBe('/inbox/doc/77'));
    expect(uploadDocument).toHaveBeenCalledTimes(1);
    expect(triageDocument).toHaveBeenCalledTimes(1);
  });

  it('an upload failure keeps the file and payer and says the upload failed', async () => {
    vi.mocked(uploadDocument)
      .mockRejectedValueOnce(new Error('413 Payload Too Large'))
      .mockResolvedValueOnce({ document: doc(), deduplicated: false });
    vi.mocked(triageDocument).mockResolvedValue({
      kind: 'invoice',
      document_id: 77,
      invoice_id: 2,
    });
    const { router } = mount();
    const file = await pick('8');
    go();
    expect(
      await screen.findByText('Upload failed: 413 Payload Too Large'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Paid by (claimant)')).toHaveValue('8');
    go();
    await waitFor(() => expect(path(router)).toBe('/books/invoices/2'));
    expect(uploadDocument).toHaveBeenLastCalledWith(file, { claimantId: 8 });
  });

  it('a double click uploads once', async () => {
    let land!: (v: unknown) => void;
    vi.mocked(uploadDocument).mockReturnValue(
      new Promise((r) => (land = r)) as never,
    );
    vi.mocked(triageDocument).mockResolvedValue({
      kind: 'invoice',
      document_id: 77,
      invoice_id: 2,
    });
    mount();
    await pick();
    const btn = screen.getByRole('button', { name: 'Upload & process' });
    fireEvent.click(btn);
    fireEvent.click(btn);
    await act(async () => land({ document: doc(), deduplicated: false }));
    await waitFor(() => expect(triageDocument).toHaveBeenCalledTimes(1));
    expect(uploadDocument).toHaveBeenCalledTimes(1);
  });

  it('a 401 in a later stage reaches sign-out with no success receipt or navigation', async () => {
    vi.mocked(uploadDocument).mockResolvedValue({
      document: doc(),
      deduplicated: false,
    });
    vi.mocked(triageDocument).mockResolvedValue({
      kind: 'unknown',
      document_id: 77,
      reason: 'x',
    });
    vi.mocked(getNeedsTriageItems).mockRejectedValue(new UnauthorizedError(1));
    const { router, onUnauthorized } = mount();
    await pick();
    go();
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalledTimes(1));
    expect(path(router)).toBe('/books?seg=documents');
    expect(screen.queryByText(/Processed without a result/)).toBeNull();
  });

  it('while the payer list loads, the payer field says so and nothing can be sent', async () => {
    vi.mocked(getEntities).mockReturnValue(new Promise(() => undefined));
    mount();
    fireEvent.change(await screen.findByLabelText('File'), {
      target: { files: [new File(['x'], 'r.pdf')] },
    });
    expect(screen.getByLabelText('Paid by (claimant)')).toBeDisabled();
    expect(
      screen.getByRole('option', { name: 'Loading payers…' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Upload & process' }),
    ).toBeDisabled();
  });

  it('while the payer list loads or failed, nothing can be uploaded as an implicit company-paid', async () => {
    vi.mocked(getEntities).mockRejectedValue(new Error('500'));
    mount();
    fireEvent.change(await screen.findByLabelText('File'), {
      target: { files: [new File(['x'], 'r.pdf')] },
    });
    expect(
      await screen.findByText(/Could not load who can pay out of pocket/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Upload & process' }),
    ).toBeDisabled();
    vi.mocked(getEntities).mockResolvedValue([MARI]);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Upload & process' }),
      ).not.toBeDisabled(),
    );
  });

  it('a selected payer removed by an entity refresh stays visible and must be corrected', async () => {
    const { qc } = mount();
    await pick('5');
    expect(
      screen.getByRole('button', { name: 'Upload & process' }),
    ).not.toBeDisabled();
    // Mari is no longer an employee (role change) — the list refetches.
    vi.mocked(getEntities).mockResolvedValue([
      SUPPLIER,
      { ...MARI, role: 'customer' } as Entity,
    ]);
    await act(() => qc.invalidateQueries());
    await waitFor(() =>
      expect(
        screen.getByText(
          'This person can no longer be chosen as the payer — choose again',
        ),
      ).toBeInTheDocument(),
    );
    const select = screen.getByLabelText('Paid by (claimant)');
    expect(select).toHaveValue('5');
    expect(
      within(select).getByRole('option', { name: /not eligible/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Upload & process' }),
    ).toBeDisabled();
    fireEvent.change(select, { target: { value: '' } });
    expect(
      screen.getByRole('button', { name: 'Upload & process' }),
    ).not.toBeDisabled();
    expect(uploadDocument).not.toHaveBeenCalled();
  });
});

describe('UploadDocumentSheet — payer list states (#260)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    setToken('test-token');
    vi.mocked(getNeedsTriageItems).mockResolvedValue([]);
  });

  it('a known-empty payer list keeps the field visible with company paid and says why', async () => {
    vi.mocked(getEntities).mockResolvedValue([SUPPLIER]);
    mount();
    // Past loading: the field shows the explicit company-paid answer.
    expect(
      await screen.findByRole('option', { name: '— company paid —' }),
    ).toBeInTheDocument();
    const select = screen.getByLabelText('Paid by (claimant)');
    expect(select).toHaveValue('');
    expect(select).toHaveAccessibleDescription(
      /No employee or director is on file/,
    );
  });

  it('an empty list whose refresh failed does not claim current absence: warning + Retry', async () => {
    vi.mocked(getEntities).mockResolvedValue([SUPPLIER]);
    const { qc } = mount();
    await screen.findByRole('option', { name: '— company paid —' });
    vi.mocked(getEntities).mockRejectedValueOnce(new Error('HTTP 503'));
    await act(() => qc.refetchQueries({ queryKey: ['entities'] }));
    expect(
      await screen.findByText(/Couldn't refresh payers \(HTTP 503\)/),
    ).toBeInTheDocument();
    const select = screen.getByLabelText('Paid by (claimant)');
    expect(select).toHaveAccessibleDescription(
      /The list loaded earlier had no/,
    );
    expect(select).not.toHaveAccessibleDescription(/is on file/);

    vi.mocked(getEntities).mockResolvedValue([SUPPLIER, MARI]);
    fireEvent.click(screen.getByRole('button', { name: 'Retry payers' }));
    expect(
      await screen.findByRole('option', { name: 'Mari Maasikas' }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Couldn't refresh payers/)).toBeNull();
  });
});

describe('UploadDocumentSheet — choose and check before processing (issue #293)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    setToken('test-token');
    vi.mocked(getEntities).mockResolvedValue([SUPPLIER, MARI, JAAN]);
    vi.mocked(getNeedsTriageItems).mockResolvedValue([]);
  });

  const selected = () => screen.getByRole('region', { name: 'Selected file' });
  const choose = (f: File) =>
    fireEvent.change(screen.getByLabelText('File'), {
      target: { files: [f] },
    });

  it('choosing a file writes nothing and reads nothing from the server; only the explicit submit sends that same File', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    vi.mocked(uploadDocument).mockResolvedValue({
      document: doc({ id: 40 }),
      deduplicated: false,
    });
    vi.mocked(triageDocument).mockResolvedValue({
      kind: 'expense',
      document_id: 40,
      expense_id: 4,
    });
    const { router } = mount();
    const file = await pick('5');
    expect(selected()).toHaveTextContent('r.pdf');
    expect(selected()).toHaveTextContent('selected on this device');
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(uploadDocument).not.toHaveBeenCalled();
    expect(triageDocument).not.toHaveBeenCalled();
    // The local preview never asks the server for a document.
    expect(
      fetchSpy.mock.calls.filter(([u]) => String(u).includes('/api/documents')),
    ).toEqual([]);
    go();
    await waitFor(() => expect(path(router)).toBe('/books/expenses/4'));
    expect(uploadDocument).toHaveBeenCalledTimes(1);
    expect(vi.mocked(uploadDocument).mock.calls[0][0]).toBe(file);
    fetchSpy.mockRestore();
  });

  it('a cancelled picker keeps the file; Remove clears it (nothing to send); another file is what gets sent', async () => {
    vi.mocked(uploadDocument).mockResolvedValue({
      document: doc({ id: 41 }),
      deduplicated: false,
    });
    vi.mocked(triageDocument).mockResolvedValue({
      kind: 'invoice',
      document_id: 41,
      invoice_id: 9,
    });
    const { router } = mount();
    await pick();
    fireEvent.change(screen.getByLabelText('File'), { target: { files: [] } });
    expect(selected()).toHaveTextContent('r.pdf');
    expect(
      screen.getByRole('button', { name: 'Upload & process' }),
    ).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(screen.queryByRole('region', { name: 'Selected file' })).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Upload & process' }),
    ).toBeDisabled();
    const other = new File(['y'], 'photo.jpg', { type: 'image/jpeg' });
    choose(other);
    expect(selected()).toHaveTextContent('photo.jpg');
    go();
    await waitFor(() => expect(path(router)).toBe('/books/invoices/9'));
    expect(uploadDocument).toHaveBeenCalledTimes(1);
    expect(vi.mocked(uploadDocument).mock.calls[0][0]).toBe(other);
  });

  it('a slow upload keeps the chosen file on screen and locked — no change, removal or second send', async () => {
    let land!: (v: unknown) => void;
    vi.mocked(uploadDocument).mockReturnValue(
      new Promise((r) => (land = r)) as never,
    );
    vi.mocked(triageDocument).mockResolvedValue({
      kind: 'expense',
      document_id: 77,
      expense_id: 1,
    });
    const { router } = mount();
    await pick();
    go();
    expect(selected()).toHaveTextContent('r.pdf');
    expect(screen.getByRole('button', { name: 'Remove' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Change file' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Close' })).toBeDisabled();
    go();
    expect(uploadDocument).toHaveBeenCalledTimes(1);
    land({ document: doc(), deduplicated: false });
    await waitFor(() => expect(path(router)).toBe('/books/expenses/1'));
  });

  it('an unconfirmed upload never claims the file is or is not stored in the file header', async () => {
    vi.mocked(uploadDocument).mockRejectedValueOnce(new Error('Network error'));
    mount();
    await pick();
    go();
    expect(
      await screen.findByText('Upload failed: Network error'),
    ).toBeInTheDocument();
    expect(selected()).toHaveTextContent('selected on this device');
    expect(selected()).not.toHaveTextContent(/not uploaded/);
  });

  it('accepted but not processed: the header names the stored document, the payer stays fixed, retry never re-uploads; another file is a new upload', async () => {
    vi.mocked(uploadDocument)
      .mockResolvedValueOnce({
        document: doc({ id: 32, claimant_id: 5 }),
        deduplicated: false,
      })
      .mockResolvedValueOnce({
        document: doc({ id: 33, claimant_id: 5 }),
        deduplicated: false,
      });
    vi.mocked(triageDocument)
      .mockRejectedValueOnce(new Error('503 Service Unavailable'))
      .mockRejectedValueOnce(new Error('503 Service Unavailable'))
      .mockResolvedValueOnce({
        kind: 'expense',
        document_id: 33,
        expense_id: 12,
      });
    const { router } = mount();
    const a = await pick('5');
    go();
    await screen.findByRole('button', { name: 'Retry processing' });
    expect(selected()).toHaveTextContent('already uploaded as document #32');
    expect(screen.getByLabelText('Paid by (claimant)')).toBeDisabled();
    expect(screen.getByLabelText('Paid by (claimant)')).toHaveValue('5');
    go('Retry processing');
    await waitFor(() => expect(triageDocument).toHaveBeenCalledTimes(2));
    expect(uploadDocument).toHaveBeenCalledTimes(1);
    expect(triageDocument).toHaveBeenLastCalledWith(32);
    // A different file is a new operation: its own upload, header and payer.
    const b = new File(['z'], 'clearer.pdf', { type: 'application/pdf' });
    choose(b);
    expect(selected()).toHaveTextContent('selected on this device');
    expect(screen.getByLabelText('Paid by (claimant)')).toBeEnabled();
    go();
    await waitFor(() => expect(path(router)).toBe('/books/expenses/12'));
    expect(uploadDocument).toHaveBeenCalledTimes(2);
    expect(vi.mocked(uploadDocument).mock.calls[0][0]).toBe(a);
    expect(vi.mocked(uploadDocument).mock.calls[1]).toEqual([
      b,
      { claimantId: 5 },
    ]);
  });
});
