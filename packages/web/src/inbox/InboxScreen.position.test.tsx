import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { RouterProvider, createBrowserRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./pdfjs', () => ({
  loadPdfJs: () => new Promise(() => undefined),
  pdfDocumentOptions: () => ({}),
}));

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  getNeedsTriageItems: vi.fn(),
  getPendingApprovals: vi.fn(),
  getExpenses: vi.fn(),
  getInvoices: vi.fn(),
  getEntities: vi.fn(),
  getReportingPeriods: vi.fn(),
  fetchDocumentPreviewObjectUrl: vi.fn(),
}));

import * as api from '../api';
import { setToken } from '../auth';
import { POSITION_ROW, resetListPositions } from '../lib/listPosition';
import { UnsavedChangesProvider } from '../lib/unsavedChanges';
import { ScreenHeader } from '../shell/Headers';
import { InboxScreen } from './InboxScreen';

/**
 * Issue #355 — the Inbox returns to the row it was left from, on the exact
 * history entry (real jsdom history via createBrowserRouter). Layout is
 * simulated: the n-th row link sits at page y = 100 + 60·n.
 */

const NOW = Math.floor(new Date('2026-09-23T12:00:00').getTime() / 1000);
const DOCS = Array.from({ length: 40 }, (_, i) => ({
  id: 12 + i,
  filename: `document-${12 + i}.pdf`,
  created_at: NOW - 86400 * 3 + i,
  reason: 'AI confidence 0.41 below threshold 0.8',
  reason_type: 'low_confidence' as const,
}));
const APPROVAL = {
  id: 7,
  object_type: 'expense',
  object_id: 214,
  status: 'pending',
  requested_by: 'system:policy',
  approved_by: null,
  rejected_reason: null,
  policy_reason: 'Voucher amount 8900 exceeds ceiling 5000',
  superseded_by: null,
  created_at: NOW - 86400 * 2,
  resolved_at: null,
};

let scrollY = 0;
function Detail() {
  return <ScreenHeader title="Detail" backTo="/inbox" />;
}

let router: ReturnType<typeof createBrowserRouter>;
function mountAt(path: string) {
  window.history.replaceState(null, '', path);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  router = createBrowserRouter([
    { path: '/inbox', element: <InboxScreen /> },
    { path: '/inbox/doc/:id', element: <Detail /> },
    { path: '/inbox/approval/:id', element: <Detail /> },
  ]);
  render(
    <QueryClientProvider client={client}>
      <UnsavedChangesProvider onUnauthorized={() => undefined}>
        <RouterProvider router={router} />
      </UnsavedChangesProvider>
    </QueryClientProvider>,
  );
}

const rows = () => [
  ...document.querySelectorAll<HTMLElement>(`[${POSITION_ROW}]`),
];
const pageTop = (el: HTMLElement) => 100 + 60 * rows().indexOf(el);
const row = (href: string) => {
  const el = rows().find((r) => r.getAttribute('href') === href);
  if (!el) throw new Error(`no row ${href}`);
  return el;
};
async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 30));
  });
}
async function open(el: HTMLElement, init: MouseEventInit = {}, at = 300) {
  scrollY = pageTop(el) - at;
  await act(async () => {
    fireEvent.click(el, { button: 0, ...init });
  });
  scrollY = 0;
}
async function headerBack() {
  await act(async () => {
    fireEvent.click(await screen.findByRole('button', { name: '‹ Back' }));
  });
  await settle();
}
const runOf = () =>
  (window.history.state as { usr?: Record<string, unknown> } | null)?.usr
    ?.hbkRun;

beforeEach(() => {
  vi.clearAllMocks();
  resetListPositions();
  setToken('token-a');
  scrollY = 0;
  vi.mocked(api.getNeedsTriageItems).mockResolvedValue(DOCS);
  vi.mocked(api.getPendingApprovals).mockResolvedValue([APPROVAL] as never);
  vi.mocked(api.getExpenses).mockResolvedValue([]);
  vi.mocked(api.getInvoices).mockResolvedValue([]);
  vi.mocked(api.getEntities).mockResolvedValue([]);
  vi.mocked(api.getReportingPeriods).mockResolvedValue([]);
  vi.mocked(api.fetchDocumentPreviewObjectUrl).mockResolvedValue('blob:t');
  Object.defineProperty(window, 'scrollY', {
    configurable: true,
    get: () => scrollY,
  });
  vi.spyOn(window, 'scrollTo').mockImplementation(((
    x: number | ScrollToOptions,
    y?: number,
  ) => {
    scrollY = typeof x === 'number' ? (y ?? 0) : (x.top ?? 0);
  }) as typeof window.scrollTo);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    function (this: HTMLElement) {
      if (!this.isConnected || !this.hasAttribute(POSITION_ROW))
        return new DOMRect(0, 0, 0, 0);
      return new DOMRect(0, pageTop(this) - scrollY, 300, 60);
    },
  );
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('InboxScreen list return (issue #355)', () => {
  it('header Back lands on the opened triage row, focused; the queue run is kept', async () => {
    mountAt('/inbox?seg=triage');
    await screen.findByText('document-42.pdf');
    await open(row('/inbox/doc/42'));
    expect(window.location.pathname).toBe('/inbox/doc/42');
    expect(runOf()).toBeDefined();
    await headerBack();
    expect(window.location.search).toBe('?seg=triage');
    expect(row('/inbox/doc/42').getBoundingClientRect().top).toBe(300);
    expect(document.activeElement).toBe(row('/inbox/doc/42'));
  });

  it('browser Back lands on an approval row', async () => {
    mountAt('/inbox');
    await screen.findByText('approve?');
    await open(row('/inbox/approval/7'), {}, 200);
    await act(async () => {
      window.history.back();
    });
    await settle();
    expect(row('/inbox/approval/7').getBoundingClientRect().top).toBe(200);
    expect(document.activeElement).toBe(row('/inbox/approval/7'));
  });

  it('a search hit opened by keyboard (single item) returns focused, the query kept', async () => {
    mountAt('/inbox?seg=triage&q=document');
    await screen.findByText('document-42.pdf');
    // Enter on a link: a click with no pointer detail.
    await open(row('/inbox/doc/42'), { detail: 0 });
    expect(runOf()).toBeUndefined();
    await headerBack();
    expect(window.location.search).toBe('?seg=triage&q=document');
    expect(row('/inbox/doc/42').getBoundingClientRect().top).toBe(300);
    expect(document.activeElement).toBe(row('/inbox/doc/42'));
  });

  it('Back → Forward → Back returns to the row again', async () => {
    mountAt('/inbox?seg=triage');
    await screen.findByText('document-42.pdf');
    await open(row('/inbox/doc/42'));
    await headerBack();
    await act(async () => {
      window.history.forward();
    });
    await settle();
    expect(window.location.pathname).toBe('/inbox/doc/42');
    scrollY = 0;
    await headerBack();
    expect(row('/inbox/doc/42').getBoundingClientRect().top).toBe(300);
    expect(document.activeElement).toBe(row('/inbox/doc/42'));
  });

  it('a failed queue-list refetch on return, then Retry, lands on the row again', async () => {
    mountAt('/inbox?seg=triage');
    await screen.findByText('document-42.pdf');
    await open(row('/inbox/doc/42'));
    // The approvals list — a queue source, not a lookup — fails to refresh.
    vi.mocked(api.getPendingApprovals).mockRejectedValue(new Error('down'));
    await headerBack();
    const retry = await screen.findByRole('button', { name: 'Retry' });
    // Not ready while a queue list has failed (cached rows stay under
    // LoadError); the page moved meanwhile.
    scrollY = 0;
    vi.mocked(api.getPendingApprovals).mockResolvedValue([APPROVAL] as never);
    // A primary press (jsdom's fireEvent.pointerDown carries no `button`).
    retry.dispatchEvent(
      new MouseEvent('pointerdown', { bubbles: true, button: 0 }),
    );
    await act(async () => {
      fireEvent.click(retry);
    });
    await settle();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(row('/inbox/doc/42').getBoundingClientRect().top).toBe(300);
    expect(document.activeElement).toBe(row('/inbox/doc/42'));
  });

  it('a failed approval-names lookup does not hold the return back', async () => {
    mountAt('/inbox?seg=triage');
    await screen.findByText('document-42.pdf');
    await open(row('/inbox/doc/42'));
    vi.mocked(api.getExpenses).mockRejectedValue(new Error('down'));
    vi.mocked(api.getEntities).mockRejectedValue(new Error('down'));
    await headerBack();
    expect(row('/inbox/doc/42').getBoundingClientRect().top).toBe(300);
    expect(document.activeElement).toBe(row('/inbox/doc/42'));
  });

  it('a new entry for the same Inbox URL (PUSH) does not inherit the position', async () => {
    mountAt('/inbox?seg=triage');
    await screen.findByText('document-42.pdf');
    await open(row('/inbox/doc/42'));
    await act(async () => {
      await router.navigate('/inbox?seg=triage');
    });
    await settle();
    expect(window.scrollY).toBe(0);
    expect(document.activeElement).toBe(document.body);
  });

  it('another session never restores this one’s position', async () => {
    mountAt('/inbox?seg=triage');
    await screen.findByText('document-42.pdf');
    await open(row('/inbox/doc/42'));
    setToken('token-b');
    await headerBack();
    expect(window.scrollY).toBe(0);
    expect(document.activeElement).toBe(document.body);
  });
});
