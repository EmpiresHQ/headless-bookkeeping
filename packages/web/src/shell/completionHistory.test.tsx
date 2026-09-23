import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import {
  RouterProvider,
  createBrowserRouter,
  type RouteObject,
} from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  getNeedsTriageItems: vi.fn(),
  getPendingApprovals: vi.fn(),
  getDocumentDetails: vi.fn(),
  getDocuments: vi.fn(),
  getExpenses: vi.fn(),
  getExpense: vi.fn(),
  getInvoices: vi.fn(),
  getEntities: vi.fn(),
  getReportingPeriods: vi.fn(),
  getCategories: vi.fn(),
  getOrganization: vi.fn(),
  completeDocument: vi.fn(),
  deleteDocument: vi.fn(),
  approveApproval: vi.fn(),
  fetchDocumentPreviewObjectUrl: vi.fn(),
  listBankStatements: vi.fn(),
  listBankTransactions: vi.fn(),
  getReconciliationStatus: vi.fn(),
  getStatementMatches: vi.fn(),
  proposeMatches: vi.fn(),
  getMatchCandidates: vi.fn(),
  getAdvanceVatTreatments: vi.fn(),
  markPersonal: vi.fn(),
  deleteBankStatement: vi.fn(),
}));

import * as api from '../api';
import type { Approval, NeedsTriageItem } from '../api';
import { setToken } from '../auth';
import { StatementScreen } from '../bank/StatementScreen';
import { StatementsScreen } from '../bank/StatementsScreen';
import { TxScreen } from '../bank/TxScreen';
import { DocumentScreen } from '../books/DocumentScreen';
import { ApprovalScreen } from '../inbox/ApprovalScreen';
import { InboxScreen } from '../inbox/InboxScreen';
import { TriageDocScreen } from '../inbox/TriageDocScreen';
import { AppToaster } from '../ui/toast';
import { AppLayout } from './AppLayout';

/**
 * Issue #252 — completion navigation vs. REAL browser history (jsdom's
 * History + popstate through createBrowserRouter): a decided / deleted task
 * must be reachable neither by Back nor by Forward; Back returns to the
 * context the task was opened from; ordinary browsing is untouched.
 */

const TRIAGE = (id: number, over: Partial<NeedsTriageItem> = {}) =>
  ({
    id,
    filename: `doc_${id}.pdf`,
    created_at: 100 + id,
    reason: 'AI confidence 0.41 below threshold 0.8',
    reason_type: 'low_confidence',
    ...over,
  }) as NeedsTriageItem;

const APPROVAL = (id: number): Approval => ({
  id,
  object_type: 'reconciliation_match',
  object_id: 41,
  status: 'pending',
  requested_by: 'system:policy',
  approved_by: null,
  rejected_reason: null,
  policy_reason: null,
  superseded_by: null,
  created_at: 50,
  resolved_at: null,
});

const TX = (id: number, description: string) => ({
  id,
  transaction_date: '2026-06-27',
  description,
  amount: -1860,
  currency: 'EUR',
  counterparty_iban: null,
  counterparty_descriptor: null,
  reference: null,
  status: 'open',
});

let triage: NeedsTriageItem[] = [];
let approvals: Approval[] = [];

function mockApi() {
  vi.mocked(api.getNeedsTriageItems).mockImplementation(() =>
    Promise.resolve(triage),
  );
  vi.mocked(api.getPendingApprovals).mockImplementation(() =>
    Promise.resolve(approvals),
  );
  vi.mocked(api.getDocumentDetails).mockImplementation((id: number) =>
    Promise.resolve({
      document_id: id,
      ocr: { ok: true, markdown: 'x' },
      classification: null,
    } as never),
  );
  vi.mocked(api.getDocuments).mockImplementation(() =>
    Promise.resolve(
      triage.map((t) => ({
        id: t.id,
        filename: t.filename,
        mime_type: 'application/pdf',
        size_bytes: 1,
        status: 'needs_triage',
        processing_since: null,
        created_at: t.created_at,
        preview_path: null,
        channel: 'upload',
        reason: t.reason,
        reason_type: t.reason_type,
        expense_id: null,
        supplier_name: null,
        claimant_name: null,
        expense_status: null,
      })) as never,
    ),
  );
  vi.mocked(api.getExpenses).mockResolvedValue([]);
  vi.mocked(api.getInvoices).mockResolvedValue([]);
  vi.mocked(api.getEntities).mockResolvedValue([]);
  vi.mocked(api.getReportingPeriods).mockResolvedValue([]);
  vi.mocked(api.getCategories).mockResolvedValue([]);
  vi.mocked(api.getOrganization).mockResolvedValue({ id: 1 } as never);
  vi.mocked(api.fetchDocumentPreviewObjectUrl).mockRejectedValue(
    new Error('no preview'),
  );
  // A decision removes the item from the server's queue.
  vi.mocked(api.completeDocument).mockImplementation((id: number) => {
    triage = triage.filter((t) => t.id !== id);
    return Promise.resolve({} as never);
  });
  vi.mocked(api.deleteDocument).mockImplementation((id: number) => {
    triage = triage.filter((t) => t.id !== id);
    return Promise.resolve({} as never);
  });
  vi.mocked(api.approveApproval).mockImplementation((id: number) => {
    approvals = approvals.filter((a) => a.id !== id);
    return Promise.resolve({} as never);
  });

  vi.mocked(api.listBankStatements).mockResolvedValue([
    { id: 3, start_date: '2026-06-01', end_date: '2026-06-30', uploaded_at: 1 },
  ]);
  vi.mocked(api.listBankTransactions).mockResolvedValue([
    TX(9, 'WOLT 220627'),
    TX(10, 'BOLT 220628'),
  ] as never);
  vi.mocked(api.getReconciliationStatus).mockResolvedValue([]);
  vi.mocked(api.getStatementMatches).mockResolvedValue([]);
  vi.mocked(api.proposeMatches).mockResolvedValue([]);
  vi.mocked(api.getMatchCandidates).mockResolvedValue({
    bankTransactionId: 9,
    lineRemaining: 1860,
    candidates: [],
  });
  vi.mocked(api.getAdvanceVatTreatments).mockResolvedValue([]);
  vi.mocked(api.markPersonal).mockResolvedValue({});
  vi.mocked(api.deleteBankStatement).mockResolvedValue(undefined as never);
}

const ROUTES: RouteObject[] = [
  {
    // The production shell: provider + blocker, TabBar and Sidebar links.
    element: (
      <AppLayout onSignOut={() => undefined} onUnauthorized={() => undefined} />
    ),
    children: [
      { path: '/start', element: <p>start page</p> },
      { path: '/books', element: <p>books list</p> },
      { path: '/settings', element: <p>settings page</p> },
      { path: '/books/documents/:id', element: <DocumentScreen /> },
      { path: '/inbox', element: <InboxScreen /> },
      { path: '/inbox/doc/:id', element: <TriageDocScreen /> },
      { path: '/inbox/approval/:id', element: <ApprovalScreen /> },
      { path: '/bank', element: <StatementsScreen /> },
      { path: '/bank/statements/:id', element: <StatementScreen /> },
      { path: '/bank/statements/:id/tx/:txId', element: <TxScreen /> },
    ],
  },
];

let routers: { dispose: () => void }[] = [];

/** Fresh app on the jsdom window whose CURRENT entry is `path` at index 0
 *  (older jsdom entries are behind it; the first push truncates any
 *  forward ones). */
function renderApp(path: string) {
  window.history.replaceState(null, '', path);
  const router = createBrowserRouter(ROUTES);
  routers.push(router);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
      <AppToaster />
    </QueryClientProvider>,
  );
  return router;
}

const here = () => window.location.pathname + window.location.search;
const idx = () => (window.history.state as { idx: number }).idx;

/** Location AND history index — a POP lands asynchronously (popstate). */
async function expectAt(href: string, at?: number) {
  await waitFor(() => {
    expect(here()).toBe(href);
    if (at !== undefined) expect(idx()).toBe(at);
  });
}

/** Real browser traversal (popstate), not router.navigate(n). */
async function browserBack(href: string, at?: number) {
  act(() => window.history.back());
  await expectAt(href, at);
}
async function browserForward(href: string, at?: number) {
  act(() => window.history.forward());
  await expectAt(href, at);
}

async function openRow(name: string | RegExp) {
  fireEvent.click(await screen.findByText(name));
}

async function archiveOpenDoc(filename: string) {
  expect(await screen.findByText(filename)).toBeInTheDocument();
  fireEvent.click(
    await screen.findByRole('button', { name: /Archive without booking/ }),
  );
  fireEvent.click(
    await screen.findByRole('button', { name: 'Archive document' }),
  );
}

async function deleteOpenDoc(filename: string) {
  expect(await screen.findByText(filename)).toBeInTheDocument();
  fireEvent.click(await screen.findByRole('button', { name: /Delete file/ }));
  fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
}

/** The screen actually rendered — not just the URL (a stale render can sit
 *  under a newer URL). */
async function expectScreen(text: string | RegExp) {
  expect(await screen.findByText(text)).toBeInTheDocument();
}

/** A native-like View Transitions API (the callback runs on a later task,
 *  as in Chromium). Route navigation must never start one (issue #252:
 *  react-router's pending view-transition state can overwrite a newer
 *  navigation's render — the URL moves on, the old screen stays). */
const startViewTransition = vi.fn((cb: () => unknown) => {
  const done = new Promise<void>((resolve) =>
    setTimeout(() => void Promise.resolve(cb()).then(() => resolve()), 0),
  );
  return {
    finished: done,
    ready: done,
    updateCallbackDone: done,
    skipTransition: () => undefined,
  };
});

/** The rendered screen's header Back (waits for a header to exist). */
const headerBack = async () => (await screen.findAllByText('‹ Back'))[0];

beforeEach(() => {
  localStorage.clear();
  setToken('test-token');
  triage = [];
  approvals = [];
  mockApi();
  Object.defineProperty(document, 'startViewTransition', {
    configurable: true,
    writable: true,
    value: startViewTransition,
  });
});

afterEach(() => {
  expect(startViewTransition).not.toHaveBeenCalled();
  delete (document as { startViewTransition?: unknown }).startViewTransition;
  for (const r of routers) r.dispose();
  routers = [];
  vi.clearAllMocks();
});

describe('Inbox completion history (#252)', () => {
  it('advance replaces the decided item: header Back returns to the originating segment, Forward never reaches it', async () => {
    triage = [TRIAGE(12), TRIAGE(13)];
    approvals = [APPROVAL(7)];
    const router = renderApp('/start');
    await act(() => router.navigate('/inbox?seg=triage'));
    await openRow('doc_12.pdf');
    await expectAt('/inbox/doc/12', 2);

    await archiveOpenDoc('doc_12.pdf');
    await expectAt('/inbox/doc/13', 2);
    expect(await screen.findByText('doc_13.pdf')).toBeInTheDocument();

    fireEvent.click(await headerBack());
    await expectAt('/inbox?seg=triage', 1);
    await browserForward('/inbox/doc/13', 2);
    await browserBack('/inbox?seg=triage', 1);
    await browserBack('/start', 0);
  });

  it('the origin segment bounds auto-advance, and the last item pops back to the real Inbox entry', async () => {
    triage = [TRIAGE(13)];
    approvals = [APPROVAL(7)]; // in the "all" queue, NOT in triage
    const router = renderApp('/start');
    await act(() => router.navigate('/inbox?seg=triage'));
    await openRow('doc_13.pdf');
    await expectAt('/inbox/doc/13', 2);

    await archiveOpenDoc('doc_13.pdf');
    // Not /inbox/approval/7: a triage-only session stays in triage.
    await expectAt('/inbox?seg=triage', 1);
    // Forward is a valid copy of the Inbox, never the archived document.
    await browserForward('/inbox?seg=triage', 2);
    await browserBack('/inbox?seg=triage', 1);
    await browserBack('/start', 0);
  });

  it('deleting a file advances the same way (no deleted object left in history)', async () => {
    triage = [TRIAGE(12, { reason_type: 'not_a_document' }), TRIAGE(13)];
    const router = renderApp('/start');
    await act(() => router.navigate('/inbox'));
    await openRow('doc_12.pdf');
    await deleteOpenDoc('doc_12.pdf');
    await expectAt('/inbox/doc/13', 2);
    await browserBack('/inbox', 1);
    await browserForward('/inbox/doc/13', 2);
  });

  it('approving the last approval returns to the Inbox entry it was opened from', async () => {
    approvals = [APPROVAL(7)];
    const router = renderApp('/start');
    await act(() => router.navigate('/inbox?seg=approvals'));
    await openRow('Bank match');
    await expectAt('/inbox/approval/7', 2);
    fireEvent.click(await screen.findByRole('button', { name: /^Approve/ }));
    await expectAt('/inbox?seg=approvals', 1);
    await browserForward('/inbox?seg=approvals', 2);
    await browserBack('/inbox?seg=approvals', 1);
    await browserBack('/start', 0);
  });

  it('approve advances; header Back then an immediate Forward renders the next approval, which approves in turn', async () => {
    approvals = [APPROVAL(7), APPROVAL(8)];
    const router = renderApp('/start');
    await act(() => router.navigate('/inbox?seg=approvals'));
    fireEvent.click((await screen.findAllByText('Bank match'))[0]);
    await expectAt('/inbox/approval/7', 2);
    fireEvent.click(await screen.findByRole('button', { name: /^Approve/ }));
    await expectAt('/inbox/approval/8', 2);
    await expectScreen('1 of 1');

    fireEvent.click(await headerBack());
    // Forward as soon as the URL is back — before any settle time (the
    // shape that exposed the stale-render race in the browser).
    await expectAt('/inbox?seg=approvals', 1);
    act(() => window.history.forward());
    await expectAt('/inbox/approval/8', 2);
    // The approval screen is what is rendered — not the Inbox list.
    await waitFor(() =>
      expect(screen.queryByLabelText('Upload document')).toBeNull(),
    );
    fireEvent.click(await screen.findByRole('button', { name: /^Approve/ }));
    await expectAt('/inbox?seg=approvals', 1);
    await expectScreen('Inbox zero');
    expect(vi.mocked(api.approveApproval).mock.calls.map((c) => c[0])).toEqual([
      7, 8,
    ]);
  });

  it('deep link: advance replaces, the last item replaces with /inbox — no pop out of the app', async () => {
    triage = [TRIAGE(12), TRIAGE(13)];
    renderApp('/inbox/doc/12');
    await archiveOpenDoc('doc_12.pdf');
    await expectAt('/inbox/doc/13', 0);
    await archiveOpenDoc('doc_13.pdf');
    await expectAt('/inbox', 0);
  });

  it('ordinary browsing keeps plain history: open A, Back, open B, Back/Forward', async () => {
    triage = [TRIAGE(12), TRIAGE(13)];
    const router = renderApp('/start');
    await act(() => router.navigate('/inbox'));
    await openRow('doc_12.pdf');
    await expectAt('/inbox/doc/12', 2);
    fireEvent.click(await headerBack());
    await expectAt('/inbox', 1);
    await openRow('doc_13.pdf');
    await expectAt('/inbox/doc/13', 2);
    await browserBack('/inbox', 1);
    await browserForward('/inbox/doc/13', 2);
  });
});

describe('cross-section entry: Books document → Resolve in Inbox (#252)', () => {
  async function openFromBooks(reason_type: NeedsTriageItem['reason_type']) {
    triage = [TRIAGE(12, { reason_type }), TRIAGE(13)];
    const router = renderApp('/start');
    await act(() => router.navigate('/books'));
    await act(() => router.navigate('/books/documents/12'));
    fireEvent.click(await screen.findByText('Resolve in Inbox'));
    await expectAt('/inbox/doc/12', 3);
    return router;
  }

  it('a decision returns to the Books document, not into the Inbox queue', async () => {
    await openFromBooks('low_confidence');
    await archiveOpenDoc('doc_12.pdf');
    await expectAt('/books/documents/12', 2);
    await browserForward('/books/documents/12', 3);
    await browserBack('/books/documents/12', 2);
    await browserBack('/books', 1);
  });

  it('deleting the file rewrites both the task and its now-invalid origin to the Books documents list', async () => {
    await openFromBooks('not_a_document');
    await deleteOpenDoc('doc_12.pdf');
    await expectAt('/books?seg=documents', 2);
    await expectScreen('books list');
    expect(screen.queryByText('Document not found')).toBeNull();
    await browserForward('/books?seg=documents', 3);
    await expectScreen('books list');
    await browserBack('/books?seg=documents', 2);
    await browserBack('/books', 1);
  });
});

describe('Bank completion history (#252)', () => {
  async function openLineFromBank() {
    const router = renderApp('/start');
    await act(() => router.navigate('/bank'));
    await openRow(/Jun/);
    await expectAt('/bank/statements/3', 2);
    fireEvent.click(await screen.findByRole('tab', { name: /^All/ }));
    await expectAt('/bank/statements/3?seg=all', 2);
    await openRow('WOLT 220627');
    await expectAt('/bank/statements/3/tx/9?seg=all', 3);
    return router;
  }

  async function recordPersonal() {
    fireEvent.click(
      await screen.findByText(/Personal · Bank fee · Prepayment/),
    );
    fireEvent.click(await screen.findByText('Personal'));
    fireEvent.click(
      await screen.findByRole('button', { name: 'Record as personal' }),
    );
    await waitFor(() => expect(api.markPersonal).toHaveBeenCalledWith(9));
  }

  it('a finished line pops back to its statement entry (segment kept); Back → Bank, Forward → valid statement copy', async () => {
    await openLineFromBank();
    await recordPersonal();
    await expectAt('/bank/statements/3?seg=all', 2);
    await expectScreen('WOLT 220627'); // the statement, not the line
    fireEvent.click(await headerBack());
    await expectAt('/bank', 1);
    await browserForward('/bank/statements/3?seg=all', 2);
    await browserForward('/bank/statements/3?seg=all', 3);
  });

  it('deep-linked line: completion replaces with the statement; header fallback Back replaces — no bounce', async () => {
    renderApp('/bank/statements/3/tx/9');
    await recordPersonal();
    await expectAt('/bank/statements/3', 0);
    await expectScreen('WOLT 220627'); // the statement, not the line
    fireEvent.click(await headerBack());
    await expectAt('/bank', 0);
  });

  it('deep-linked line → header Back → statement → header Back → Bank, never back into the line', async () => {
    renderApp('/bank/statements/3/tx/9');
    expect(
      await screen.findByText(/Personal · Bank fee · Prepayment/),
    ).toBeInTheDocument();
    fireEvent.click(await headerBack());
    await expectAt('/bank/statements/3', 0);
    expect(await screen.findByText('WOLT 220627')).toBeInTheDocument();
    fireEvent.click(await headerBack());
    await expectAt('/bank', 0);
  });

  it('deleting a statement returns to the Bank entry it was opened from', async () => {
    const router = renderApp('/start');
    await act(() => router.navigate('/bank'));
    await openRow(/Jun/);
    await expectAt('/bank/statements/3', 2);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    fireEvent.click(
      await screen.findByRole('button', { name: 'Delete statement' }),
    );
    await expectAt('/bank', 1);
    await browserForward('/bank', 2);
    await browserBack('/bank', 1);
    await browserBack('/start', 0);
  });
});

describe('return chain ownership (#252)', () => {
  it('a newer navigation between the replacement and the POP ends the chain — no late POP', async () => {
    const router = await (async () => {
      const r = renderApp('/start');
      await act(() => r.navigate('/bank'));
      await openRow(/Jun/);
      await openRow('WOLT 220627');
      await expectAt('/bank/statements/3/tx/9', 3);
      return r;
    })();
    let injected = false;
    const off = router.subscribe((s) => {
      const st = s.location.state as { hbkReturn?: string } | null;
      if (!injected && st?.hbkReturn) {
        injected = true;
        void router.navigate('/books');
      }
    });
    await (async () => {
      fireEvent.click(
        await screen.findByText(/Personal · Bank fee · Prepayment/),
      );
      fireEvent.click(await screen.findByText('Personal'));
      fireEvent.click(
        await screen.findByRole('button', { name: 'Record as personal' }),
      );
    })();
    await expectAt('/books', 4);
    off();
    // Give any stray continuation a chance to run: nothing may move.
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(here()).toBe('/books');
    expect(idx()).toBe(4);
    await browserBack('/bank/statements/3', 3);
  });

  it('a session change after the replacement ends the chain — the safe copy stays, no POP', async () => {
    const r = renderApp('/start');
    await act(() => r.navigate('/bank'));
    await openRow(/Jun/);
    await openRow('WOLT 220627');
    await expectAt('/bank/statements/3/tx/9', 3);
    const off = r.subscribe((s) => {
      const st = s.location.state as { hbkReturn?: string } | null;
      if (st?.hbkReturn) setToken('another-session');
    });
    fireEvent.click(
      await screen.findByText(/Personal · Bank fee · Prepayment/),
    );
    fireEvent.click(await screen.findByText('Personal'));
    fireEvent.click(
      await screen.findByRole('button', { name: 'Record as personal' }),
    );
    await expectAt('/bank/statements/3', 3);
    off();
    await act(() => new Promise((res) => setTimeout(res, 20)));
    expect(idx()).toBe(3);
  });
});

describe('route links start no view transition (#252)', () => {
  it('control: the stub is live — an opted-in navigation would call it', async () => {
    const router = renderApp('/start');
    await act(() => router.navigate('/books', { viewTransition: true }));
    await waitFor(() => expect(startViewTransition).toHaveBeenCalled());
    await expectScreen('books list');
    startViewTransition.mockClear();
  });

  it('section tabs, rows, header Back and link buttons navigate and render without one', async () => {
    triage = [TRIAGE(12)];
    renderApp('/start');
    fireEvent.click(screen.getAllByRole('link', { name: /Inbox/ })[0]);
    await expectAt('/inbox', 1);
    await openRow('doc_12.pdf');
    await expectAt('/inbox/doc/12', 2);
    await expectScreen('doc_12.pdf');
    fireEvent.click(await headerBack());
    await expectAt('/inbox', 1);
    fireEvent.click(screen.getAllByRole('link', { name: /Bank/ })[0]);
    await expectAt('/bank', 2);
    await openRow(/Jun/);
    await expectAt('/bank/statements/3', 3);
    await expectScreen('WOLT 220627');
    fireEvent.click(screen.getAllByRole('link', { name: /Settings/ })[0]);
    await expectAt('/settings', 4);
    await expectScreen('settings page');
    await browserBack('/bank/statements/3', 3);
    await expectScreen('WOLT 220627');
  });
});
