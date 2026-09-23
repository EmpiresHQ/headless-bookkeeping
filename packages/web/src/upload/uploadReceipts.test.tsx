import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api', async (io) => ({
  ...(await io<typeof import('../api')>()),
  uploadDocument: vi.fn(),
  triageDocument: vi.fn(),
  getEntities: vi.fn(),
  getNeedsTriageItems: vi.fn(),
}));
import {
  getEntities,
  getNeedsTriageItems,
  triageDocument,
  uploadDocument,
  type DocumentRow,
  type Entity,
} from '../api';
import { SESSION_ID_KEY, setToken } from '../auth';
import { ImportScreen } from '../bank/ImportScreen';
import { UnsavedChangesProvider } from '../lib/unsavedChanges';
import { RESULT_LOG_KEY, ResultLogProvider } from '../lib/resultLog';
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
        <ResultLogProvider>
          <AppToaster />
          <RouterProvider router={router} />
        </ResultLogProvider>
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

type Stored = {
  session: string;
  entries: {
    title: string;
    outcome: string;
    tone: string;
    links: { to: string }[];
  }[];
};
const stored = (): Stored =>
  JSON.parse(
    sessionStorage.getItem(RESULT_LOG_KEY) ?? '{"session":"","entries":[]}',
  );

describe('upload durable receipts (issue #259)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    setToken('test-token');
    vi.mocked(getEntities).mockResolvedValue([SUPPLIER, MARI, JAAN]);
    vi.mocked(getNeedsTriageItems).mockResolvedValue([]);
  });

  it('an unconfirmed upload is recorded by file name without claiming either way; the retry of the same file supersedes it', async () => {
    vi.mocked(uploadDocument)
      .mockRejectedValueOnce(new Error('503 Service Unavailable'))
      .mockResolvedValueOnce({ document: doc(), deduplicated: false });
    vi.mocked(triageDocument).mockResolvedValue({
      kind: 'invoice',
      document_id: 77,
      invoice_id: 2,
    });
    const { router } = mount();
    await pick();
    go();
    await waitFor(() => expect(stored().entries[0]?.tone).toBe('error'));
    const [failed] = stored().entries;
    expect(failed.title).toBe('r.pdf');
    expect(failed.outcome).toMatch(
      /not confirmed — no document ID was received/,
    );
    expect(failed.outcome).toMatch(/may or may not be stored/);
    go();
    await waitFor(() => expect(path(router)).toBe('/books/invoices/2'));
    expect(stored().entries).toHaveLength(1);
    expect(stored().entries[0]).toMatchObject({
      tone: 'ok',
      outcome: 'Sales invoice recorded',
    });
    expect(stored().entries[0].links.map((l) => l.to)).toEqual([
      '/books/invoices/2',
      '/books/documents/77',
    ]);
  });

  it('the accepted document is recorded BEFORE processing answers; a processing failure is partial, never a total failure', async () => {
    vi.mocked(uploadDocument).mockResolvedValue({
      document: doc({ id: 32 }),
      deduplicated: false,
    });
    let fail!: (e: unknown) => void;
    vi.mocked(triageDocument).mockReturnValue(
      new Promise((_, r) => {
        fail = r;
      }) as never,
    );
    mount();
    await pick();
    go();
    await waitFor(() =>
      expect(stored().entries[0]?.outcome).toBe('Document #32 — processing…'),
    );
    expect(stored().entries[0].tone).toBe('running');
    expect(stored().entries[0].links[0].to).toBe('/books/documents/32');
    await act(async () => fail(new Error('503 Service Unavailable')));
    await waitFor(() => expect(stored().entries[0]?.tone).toBe('partial'));
    expect(stored().entries[0].outcome).toMatch(
      /Stored as document #32, but processing was not confirmed/,
    );
    expect(stored().entries[0].outcome).toMatch(
      /while this upload sheet is still open/,
    );
    expect(stored().entries[0].outcome).not.toMatch(
      /uploading the same file again (will|retries)/,
    );
  });

  it('a handled duplicate is "reading its stored result", never "processing"', async () => {
    vi.mocked(uploadDocument).mockResolvedValue({
      document: doc({ status: 'processed' }),
      deduplicated: true,
    });
    const seen: string[] = [];
    const orig = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
      this: Storage,
      k: string,
      v: string,
    ) {
      if (k === RESULT_LOG_KEY) seen.push(v);
      return orig.call(this, k, v);
    });
    const { router } = mount();
    await pick();
    go();
    await waitFor(() => expect(path(router)).toBe('/books/documents/77'));
    expect(seen.join('\n')).toMatch(/reading its stored result/);
    expect(seen.join('\n')).not.toMatch(/processing…/);
    expect(triageDocument).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('upload failure → same-token sign-in elsewhere → retry of the SAME file: one new-session result, the old one gone', async () => {
    vi.mocked(uploadDocument)
      .mockRejectedValueOnce(new Error('503 Service Unavailable'))
      .mockResolvedValueOnce({ document: doc(), deduplicated: false });
    vi.mocked(triageDocument).mockResolvedValue({
      kind: 'invoice',
      document_id: 77,
      invoice_id: 2,
    });
    const { router } = mount();
    await pick();
    go();
    await waitFor(() => expect(stored().entries[0]?.tone).toBe('error'));
    localStorage.setItem(SESSION_ID_KEY, 'other-tab-session');
    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: SESSION_ID_KEY,
          newValue: 'other-tab-session',
        }),
      );
    });
    expect(sessionStorage.getItem(RESULT_LOG_KEY)).toBeNull();
    go();
    await waitFor(() => expect(path(router)).toBe('/books/invoices/2'));
    expect(stored().session).toBe('other-tab-session');
    expect(stored().entries).toHaveLength(1);
    expect(stored().entries[0]).toMatchObject({
      tone: 'ok',
      outcome: 'Sales invoice recorded',
    });
  });
});
