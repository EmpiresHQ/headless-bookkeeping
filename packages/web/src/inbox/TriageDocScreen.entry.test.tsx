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
  getDocumentDetails: vi.fn(),
  getExpenses: vi.fn(),
  getInvoices: vi.fn(),
  getEntities: vi.fn(),
  getReportingPeriods: vi.fn(),
  fetchDocumentPreviewObjectUrl: vi.fn(),
  completeDocument: vi.fn(),
}));

import * as api from '../api';
import { setToken } from '../auth';
import { POSITION_ROW, resetListPositions } from '../lib/listPosition';
import { resetScreenEntries } from '../lib/screenEntry';
import { UnsavedChangesProvider } from '../lib/unsavedChanges';
import { InboxScreen } from './InboxScreen';
import { TriageDocScreen } from './TriageDocScreen';

/**
 * Issue #357 on the real Inbox queue: a document opened from deep in the
 * list, and the next one after a decision, start at their top with focus on
 * the heading that names the document — never on the body or an action.
 * The page offset is simulated (jsdom has no layout); every API is mocked.
 */

const NOW = Math.floor(new Date('2026-09-23T12:00:00').getTime() / 1000);
const DOCS = Array.from({ length: 40 }, (_, i) => ({
  id: 12 + i,
  filename: `document-${12 + i}.pdf`,
  created_at: NOW - 86400 * 3 + i,
  reason: 'AI confidence 0.41 below threshold 0.8',
  reason_type: 'low_confidence' as const,
}));

let scrollY = 0;

function mountAt(path: string) {
  window.history.replaceState(null, '', path);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const router = createBrowserRouter([
    { path: '/inbox', element: <InboxScreen /> },
    { path: '/inbox/doc/:id', element: <TriageDocScreen /> },
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
const heading = (name: RegExp) =>
  screen.findByRole('heading', { level: 1, name });

beforeEach(() => {
  vi.clearAllMocks();
  resetListPositions();
  resetScreenEntries();
  setToken('token-a');
  scrollY = 0;
  vi.mocked(api.getNeedsTriageItems).mockResolvedValue(DOCS);
  vi.mocked(api.getPendingApprovals).mockResolvedValue([]);
  vi.mocked(api.getDocumentDetails).mockImplementation(
    async (id: number) =>
      ({ document_id: id, ocr: null, classification: null }) as never,
  );
  vi.mocked(api.getExpenses).mockResolvedValue([]);
  vi.mocked(api.getInvoices).mockResolvedValue([]);
  vi.mocked(api.getEntities).mockResolvedValue([]);
  vi.mocked(api.getReportingPeriods).mockResolvedValue([]);
  vi.mocked(api.fetchDocumentPreviewObjectUrl).mockResolvedValue('blob:t');
  vi.mocked(api.completeDocument).mockResolvedValue({
    id: 12,
    status: 'processed',
  } as never);
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

describe('Inbox document entry (issue #357)', () => {
  it('opens a deep row at the top on its named heading; the next document after Archive does too; Back still finds the row', async () => {
    mountAt('/inbox?seg=triage');
    await screen.findByText('document-42.pdf');
    scrollY = pageTop(row('/inbox/doc/42')) - 300;
    await act(async () => {
      fireEvent.click(row('/inbox/doc/42'), { button: 0 });
    });
    await settle();
    expect(window.location.pathname).toBe('/inbox/doc/42');
    expect(window.scrollY).toBe(0);
    expect(document.activeElement).toBe(
      await heading(/^Document document-42\.pdf, \d+ of \d+$/),
    );

    // Read down the document, then decide it.
    scrollY = 900;
    fireEvent.click(
      screen.getByRole('button', { name: 'Archive without booking' }),
    );
    await act(async () => {
      fireEvent.click(
        await screen.findByRole('button', { name: 'Archive document' }),
      );
    });
    await settle();
    expect(api.completeDocument).toHaveBeenCalledTimes(1);
    expect(window.location.pathname).toBe('/inbox/doc/41');
    expect(window.scrollY).toBe(0);
    expect(document.activeElement).toBe(
      await heading(/^Document document-41\.pdf, \d+ of \d+$/),
    );

    // The decided document's entry was replaced: Back is the list, on the
    // row it was opened from.
    await act(async () => {
      window.history.back();
    });
    await settle();
    expect(window.location.search).toBe('?seg=triage');
    expect(row('/inbox/doc/42').getBoundingClientRect().top).toBe(300);
    expect(document.activeElement).toBe(row('/inbox/doc/42'));
    expect(api.completeDocument).toHaveBeenCalledTimes(1);
  });
});
