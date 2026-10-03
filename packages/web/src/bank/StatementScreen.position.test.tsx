import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { RouterProvider, createBrowserRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  listBankStatements: vi.fn(),
  listBankTransactions: vi.fn(),
  getReconciliationStatus: vi.fn(),
  getStatementMatches: vi.fn(),
  proposeMatches: vi.fn(),
  executeMatches: vi.fn(),
  approveApproval: vi.fn(),
  getPendingApprovals: vi.fn(),
  deleteBankStatement: vi.fn(),
}));

import * as api from '../api';
import type { BankTransaction, MatchProposalView } from '../api';
import { setToken } from '../auth';
import { POSITION_ROW, resetListPositions } from '../lib/listPosition';
import { ResultLogProvider } from '../lib/resultLog';
import { UnsavedChangesProvider } from '../lib/unsavedChanges';
import { ScreenHeader } from '../shell/Headers';
import { StatementScreen } from './StatementScreen';

/**
 * Issue #355 — a statement returns to the line control it was left from:
 * the exact navigation button (one of several proposal / staged rows of a
 * line), never its checkbox or Confirm. Real browser history (jsdom) via
 * createBrowserRouter; layout is simulated: the n-th navigation control in
 * the document sits at page y = 100 + 60·n.
 */

const LINES = 40;
const tx = (id: number, status = 'open'): BankTransaction => ({
  id,
  transaction_date: '2026-09-10',
  description: `Bank line ${id}`,
  amount: -1000 - id,
  currency: 'EUR',
  counterparty_iban: null,
  counterparty_descriptor: null,
  reference: null,
  status,
});
const proposal = (txId: number, voucherId: number): MatchProposalView => ({
  bankTransactionId: txId,
  voucherId,
  matchType: 'exact',
  amountMatched: 1000 + txId,
  confidence: 'medium',
  signal: 'counterparty',
  objectType: 'expense',
  objectId: voucherId,
  objectLabel: `Expense #${voucherId}`,
  counterpartyName: null,
  voucherRemaining: 1000 + txId,
});
// Line 930: two proposals; line 931: a staged draft; line 932 is matched.
const PROPOSALS = [proposal(930, 71), proposal(930, 72)];

function mockData() {
  const ids = Array.from({ length: LINES }, (_, i) => 900 + i);
  vi.mocked(api.listBankStatements).mockResolvedValue([
    { id: 3, start_date: '2026-09-01', end_date: '2026-09-30', uploaded_at: 1 },
  ]);
  vi.mocked(api.listBankTransactions).mockResolvedValue(ids.map((i) => tx(i)));
  vi.mocked(api.getReconciliationStatus).mockResolvedValue(
    ids.map((i) => ({
      bankTransactionId: i,
      amountBase: 1000 + i,
      matchedSum: i === 932 ? 1000 + i : 0,
      remaining: i === 932 ? 0 : 1000 + i,
      reconStatus: i === 932 ? 'matched' : 'open',
    })),
  );
  vi.mocked(api.getStatementMatches).mockResolvedValue([
    {
      id: 41,
      bankTransactionId: 932,
      status: 'active',
      amountMatched: 1932,
      objectLabel: 'Expense #61',
      counterpartyName: null,
    },
    {
      id: 50,
      bankTransactionId: 931,
      status: 'draft',
      amountMatched: 1931,
      objectLabel: 'Expense #70',
      counterpartyName: null,
    },
  ]);
  vi.mocked(api.proposeMatches).mockResolvedValue(PROPOSALS);
}

let scrollY = 0;
function TxDetail() {
  return <ScreenHeader title="Transaction" backTo="/bank" />;
}

let router: ReturnType<typeof createBrowserRouter>;
let client: QueryClient;
function mountAt(path: string) {
  window.history.replaceState(null, '', path);
  client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  router = createBrowserRouter([
    { path: '/bank', element: <p>bank list</p> },
    { path: '/bank/statements/:id', element: <StatementScreen /> },
    { path: '/bank/statements/:id/tx/:txId', element: <TxDetail /> },
  ]);
  render(
    <QueryClientProvider client={client}>
      <UnsavedChangesProvider onUnauthorized={() => undefined}>
        <ResultLogProvider>
          <RouterProvider router={router} />
        </ResultLogProvider>
      </UnsavedChangesProvider>
    </QueryClientProvider>,
  );
}

const controls = () => [
  ...document.querySelectorAll<HTMLElement>(`[${POSITION_ROW}]`),
];
const pageTop = (el: HTMLElement) => 100 + 60 * controls().indexOf(el);
/** The navigation control whose text includes `text`. */
const nav = (text: string) => {
  const el = controls().find((c) => c.textContent?.includes(text));
  if (!el) throw new Error(`no control ${text}`);
  return el;
};
async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 30));
  });
}
async function open(el: HTMLElement, at = 300) {
  scrollY = pageTop(el) - at;
  await act(async () => {
    fireEvent.click(el, { button: 0, detail: 0 });
  });
  scrollY = 0; // the detail starts at its top
}
async function headerBack() {
  await act(async () => {
    fireEvent.click(await screen.findByRole('button', { name: '‹ Back' }));
  });
  await settle();
}

// A ResizeObserver that never reports: every re-anchor below comes from
// the committed row set itself, as when a refetch keeps the list's height.
class SilentResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  vi.clearAllMocks();
  resetListPositions();
  setToken('token-a');
  mockData();
  scrollY = 0;
  vi.stubGlobal('ResizeObserver', SilentResizeObserver);
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
  vi.unstubAllGlobals();
});

describe('StatementScreen list return (issue #355)', () => {
  it('header Back lands on the SECOND proposal control opened, focused — not the first, the checkbox or the line', async () => {
    mountAt('/bank/statements/3');
    await screen.findByText('AI proposals');
    await open(nav('Expense #72'));
    expect(window.location.pathname).toBe('/bank/statements/3/tx/930');
    await headerBack();
    expect(window.location.pathname).toBe('/bank/statements/3');
    const second = nav('Expense #72');
    expect(second.getBoundingClientRect().top).toBe(300);
    expect(document.activeElement).toBe(second);
    expect(document.activeElement).not.toBe(nav('Expense #71'));
    expect(document.activeElement?.getAttribute('role')).not.toBe('checkbox');
  });

  it('browser Back lands on a staged control, never its Confirm', async () => {
    mountAt('/bank/statements/3');
    await screen.findByText('AI proposals');
    await open(nav('Expense #70'), 250);
    await act(async () => {
      window.history.back();
    });
    await settle();
    const staged = nav('Expense #70');
    expect(staged.getBoundingClientRect().top).toBe(250);
    expect(document.activeElement).toBe(staged);
    expect(document.activeElement).not.toBe(
      screen.getByRole('button', { name: 'Confirm' }),
    );
  });

  it('a Done row with a search query returns focused, the query kept', async () => {
    mountAt('/bank/statements/3?seg=all&q=Bank+line+93');
    await screen.findByText('Matched');
    await open(nav('Expense #61'), 200);
    expect(window.location.search).toBe('?seg=all');
    await headerBack();
    expect(window.location.search).toBe('?seg=all&q=Bank+line+93');
    const done = nav('Expense #61');
    expect(done.getBoundingClientRect().top).toBe(200);
    expect(document.activeElement).toBe(done);
  });

  it('Back → Forward → Back returns to the second proposal again', async () => {
    mountAt('/bank/statements/3');
    await screen.findByText('AI proposals');
    await open(nav('Expense #72'));
    await headerBack();
    await act(async () => {
      window.history.forward();
    });
    await settle();
    expect(window.location.pathname).toBe('/bank/statements/3/tx/930');
    scrollY = 0;
    await headerBack();
    expect(nav('Expense #72').getBoundingClientRect().top).toBe(300);
    expect(document.activeElement).toBe(nav('Expense #72'));
  });

  it('a refetch swapping the opened proposal hands focus to its line, then back — no resize fired', async () => {
    mountAt('/bank/statements/3');
    await screen.findByText('AI proposals');
    await open(nav('Expense #72'));
    // Meanwhile #72 was replaced by #73: the same number of rows, the same
    // height — no ResizeObserver callback is fired anywhere in this test.
    // The cached proposals show #72 first; the refetch swaps it out.
    vi.mocked(api.proposeMatches).mockResolvedValue([
      proposal(930, 71),
      proposal(930, 73),
    ]);
    await headerBack();
    await settle();
    expect(() => nav('Expense #72')).toThrow();
    const first = nav('Expense #71');
    expect(document.activeElement).toBe(first);
    expect(first.getBoundingClientRect().top).toBe(300);
    // A later refetch brings #72 back while #71 stays: the list re-anchors
    // on #72 and focus moves from the stand-in to it.
    vi.mocked(api.proposeMatches).mockResolvedValue(PROPOSALS);
    await act(async () => {
      await client.refetchQueries();
    });
    await settle();
    expect(nav('Expense #71')).toBeInTheDocument();
    expect(nav('Expense #72').getBoundingClientRect().top).toBe(300);
    expect(document.activeElement).toBe(nav('Expense #72'));
  });

  it('a failed proposals read still returns (settled); its Retry re-anchors the exact control', async () => {
    vi.mocked(api.proposeMatches).mockRejectedValue(new Error('down'));
    mountAt('/bank/statements/3');
    await screen.findByText("Couldn't load AI proposals");
    // Line 930 sits under "Decide yourself" while proposals are missing.
    await open(nav('Bank line 930'));
    await headerBack();
    await screen.findByText("Couldn't load AI proposals");
    const line = nav('Bank line 930');
    expect(line.getBoundingClientRect().top).toBe(300);
    expect(document.activeElement).toBe(line);
    // Retry is a recovery, not scroll intent: the proposals arrive, the
    // line moves to its proposal rows and the list follows it there.
    vi.mocked(api.proposeMatches).mockResolvedValue(PROPOSALS);
    await act(async () => {
      // A primary press (jsdom's fireEvent.pointerDown carries no `button`).
      screen
        .getByRole('button', { name: 'Retry' })
        .dispatchEvent(
          new MouseEvent('pointerdown', { bubbles: true, button: 0 }),
        );
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    });
    await screen.findByText('AI proposals');
    await settle();
    const back = nav('Bank line 930');
    expect(back.textContent).toContain('Expense #71');
    expect(back.getBoundingClientRect().top).toBe(300);
    expect(document.activeElement).toBe(back);
  });

  it('a new entry for the same statement (PUSH) does not inherit the position', async () => {
    mountAt('/bank/statements/3');
    await screen.findByText('AI proposals');
    await open(nav('Expense #72'));
    await act(async () => {
      await router.navigate('/bank/statements/3');
    });
    await settle();
    expect(window.location.pathname).toBe('/bank/statements/3');
    expect(window.scrollY).toBe(0);
    expect(document.activeElement).toBe(document.body);
  });

  it('another session never restores this one’s position', async () => {
    mountAt('/bank/statements/3');
    await screen.findByText('AI proposals');
    await open(nav('Expense #72'));
    setToken('token-b');
    await headerBack();
    expect(window.scrollY).toBe(0);
    expect(document.activeElement).toBe(document.body);
  });
});
