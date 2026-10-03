import { focusManager } from '@tanstack/react-query';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { StrictMode } from 'react';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getToken, setToken } from '../auth';
import { buildRoutes } from './router';

/**
 * Issue #251 — the pending-operation contract (protected waiting, bound to
 * the session) through the PRODUCTION route tree: Root's per-session scope,
 * AppLayout's provider and its single route blocker. Every request is a
 * fixture; the create/post replies are held and released by the test.
 */

const expense = (id: number) => ({
  id,
  document_id: null,
  supplier_id: null,
  category: 'office',
  gross_amount: 1000,
  vat_amount: 180,
  currency: 'EUR',
  tax_point_date: '2026-01-01',
  status: 'draft',
  supplier_invoice_number: null,
  ai_confidence: null,
  claimant_id: null,
  company_addressed_receipt: null,
  created_at: 0,
});

type Reply = { status: number; body: unknown };
const json = ({ status, body }: Reply) =>
  new Response(JSON.stringify(body), { status });

/** Held writes: each POST waits until the test answers it. */
let held: { url: string; body: unknown; answer: (r: Reply) => void }[] = [];
let failNextGet401 = false;

function mockApi() {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (method !== 'GET') {
      return new Promise<Response>((resolve) => {
        held.push({
          url,
          body: init?.body ? JSON.parse(String(init.body)) : null,
          answer: (r) => resolve(json(r)),
        });
      });
    }
    if (failNextGet401) {
      failNextGet401 = false;
      return Promise.resolve(json({ status: 401, body: { message: 'no' } }));
    }
    const ok = (body: unknown) => Promise.resolve(json({ status: 200, body }));
    const one = /\/api\/expenses\/(\d+)$/.exec(url);
    if (one) return ok(expense(Number(one[1])));
    if (url.includes('/api/expenses')) return ok({ expenses: [] });
    if (url.includes('/api/categories'))
      return ok({
        categories: [{ key: 'office', label: 'Office', accountCode: 'X' }],
      });
    if (url.includes('/api/triage/needs-triage')) return ok({ items: [] });
    if (url.includes('/api/approvals')) return ok({ approvals: [] });
    if (url.includes('/api/sales-invoices')) return ok({ invoices: [] });
    if (url.includes('/api/entities')) return ok({ entities: [] });
    if (url.includes('/api/documents')) return ok({ documents: [] });
    if (url.includes('/api/credit-notes')) return ok({ credit_notes: [] });
    if (url.includes('/admin/settings')) return ok({ settings: [] });
    return ok([]);
  });
}

function renderAt(entries: string[], strict = false) {
  const router = createMemoryRouter(buildRoutes(), {
    initialEntries: entries,
    initialIndex: entries.length - 1,
  });
  const app = <RouterProvider router={router} />;
  render(strict ? <StrictMode>{app}</StrictMode> : app);
  return router;
}

const path = (r: ReturnType<typeof renderAt>) => r.state.location.pathname;

async function fillNewExpense() {
  fireEvent.click(
    await screen.findByRole('button', { name: 'Add to the books' }),
  );
  fireEvent.click(await screen.findByText('New expense'));
  await screen.findByRole('option', { name: 'Office' });
  fireEvent.change(screen.getByLabelText('Category'), {
    target: { value: 'office' },
  });
  fireEvent.change(screen.getByLabelText('Gross (€)'), {
    target: { value: '123.45' },
  });
  fireEvent.change(screen.getByLabelText('Tax point date'), {
    target: { value: '2026-09-01' },
  });
}

const createButton = () =>
  screen.getByRole('button', { name: /Create expense/ });

async function submitHeld() {
  fireEvent.click(createButton());
  await waitFor(() => expect(held).toHaveLength(1));
  return held[0];
}

/** A query 401 elsewhere in the shell (focus refetch of stale data). */
async function forceQuery401() {
  const now = Date.now();
  vi.spyOn(Date, 'now').mockReturnValue(now + 120_000);
  failNextGet401 = true;
  act(() => {
    focusManager.setFocused(false);
    focusManager.setFocused(true);
  });
  expect(await screen.findByLabelText('API token')).toBeInTheDocument();
  vi.mocked(Date.now).mockRestore();
  focusManager.setFocused(undefined);
}

function signIn(token: string) {
  fireEvent.change(screen.getByLabelText('API token'), {
    target: { value: token },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
}

describe('pending operations on the production routes (#251)', () => {
  beforeEach(() => {
    localStorage.clear();
    setToken('test-token');
    held = [];
    failNextGet401 = false;
    mockApi();
  });
  afterEach(() => {
    held.forEach((h) => h.answer({ status: 500, body: {} }));
    vi.restoreAllMocks();
  });

  it('same-tick double submit sends ONE request', async () => {
    renderAt(['/books']);
    await fillNewExpense();
    const button = createButton();
    act(() => {
      // Two clicks in one batch: the second one sees the pre-render state.
      button.click();
      button.click();
    });
    await waitFor(() => expect(held).toHaveLength(1));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(held.filter((h) => h.url.endsWith('/api/expenses'))).toHaveLength(1);
  });

  it('while saving: fields locked, Escape/section link/Back/sign-out refused with a status, unload prompts; success navigates once', async () => {
    const router = renderAt(['/settings', '/books']);
    await fillNewExpense();
    const post = await submitHeld();

    // Locked: what was submitted is what the success releases.
    expect(screen.getByLabelText('Gross (€)')).toBeDisabled();
    expect(screen.getByText(/Saving… the form is locked/)).toBeInTheDocument();

    // Escape: no close, and no discard question for a form mid-save.
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(
      screen.getByRole('dialog', { name: 'New expense' }),
    ).toBeInTheDocument();

    // Section link and Back: refused outright, with the protected-wait status.
    await act(() => router.navigate('/settings'));
    expect(path(router)).toBe('/books');
    await act(() => router.navigate(-1));
    expect(path(router)).toBe('/books');
    expect(
      await screen.findByText(/“New expense” is still saving/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).toBeNull();

    // Sign-out: refused too (behind the modal sheet — hidden to a11y queries,
    // still the same confirmLeave path).
    fireEvent.click(
      screen.getAllByRole('button', { name: 'Sign out', hidden: true })[0],
    );
    expect(screen.queryByLabelText('API token')).toBeNull();
    expect(getToken()).toBe('test-token');

    // Refresh/close: the browser's prompt.
    const unload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);

    await act(async () =>
      post.answer({ status: 200, body: { ...expense(24), id: 24 } }),
    );
    await waitFor(() => expect(path(router)).toBe('/books/expenses/24'));
    expect(held).toHaveLength(1);
    const after = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
  });

  it('a failure unlocks with the values kept and still guarded; one deliberate retry succeeds', async () => {
    const router = renderAt(['/books']);
    await fillNewExpense();
    (await submitHeld()).answer({
      status: 503,
      body: { message: 'Fixture unavailable' },
    });
    await waitFor(() => expect(createButton()).not.toBeDisabled());
    expect(screen.getByLabelText('Gross (€)')).not.toBeDisabled();
    expect(screen.getByLabelText('Gross (€)')).toHaveValue('123.45');
    expect(path(router)).toBe('/books');

    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(
      await screen.findByRole('button', { name: 'Keep editing' }),
    );
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());

    fireEvent.click(createButton());
    await waitFor(() => expect(held).toHaveLength(2));
    await act(async () =>
      held[1].answer({ status: 200, body: { ...expense(25), id: 25 } }),
    );
    await waitFor(() => expect(path(router)).toBe('/books/expenses/25'));
  });

  it('a clean screen action is protected too (independent of the dirty flag)', async () => {
    const router = renderAt(['/books/expenses/5']);
    fireEvent.click(
      await screen.findByRole('button', { name: /Submit for posting/ }),
    );
    await waitFor(() => expect(held).toHaveLength(1));
    await act(() => router.navigate('/settings'));
    expect(path(router)).toBe('/books/expenses/5');
    const unload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
    await act(async () =>
      held[0].answer({
        status: 200,
        body: {
          expense: { ...expense(5), status: 'posted' },
          policy: { action: 'auto-post', reason: 'ok' },
        },
      }),
    );
    await act(() => router.navigate('/settings'));
    expect(path(router)).toBe('/settings');
  });

  it.each([
    ['success', { status: 200, body: { ...expense(24), id: 24 } }],
    ['failure', { status: 503, body: { message: 'Old failure' } }],
    ['late 401', { status: 401, body: { message: 'Old 401' } }],
  ] as const)(
    'forced 401 + new sign-in: the old request’s %s never acts on the new session',
    async (_label, reply) => {
      const router = renderAt(['/books']);
      await fillNewExpense();
      const post = await submitHeld();

      await forceQuery401();
      signIn('new-session-token');
      await screen.findByRole('button', { name: 'Add to the books' });
      await act(() => router.navigate('/settings'));
      expect(path(router)).toBe('/settings');

      await act(async () => post.answer(reply));
      // Give any stale continuation every chance to run.
      await act(async () => {
        await new Promise((r) => setTimeout(r, 20));
      });
      expect(path(router)).toBe('/settings');
      expect(getToken()).toBe('new-session-token');
      expect(screen.queryByLabelText('API token')).toBeNull();
      expect(
        screen.queryByText(/Old failure|Old 401|Draft created/),
      ).toBeNull();
      expect(held).toHaveLength(1);
    },
  );

  it('StrictMode (as in production): the session client survives effect replay — data loads and an operation completes', async () => {
    const router = renderAt(['/books/expenses/5'], true);
    fireEvent.click(
      await screen.findByRole('button', { name: /Submit for posting/ }),
    );
    await waitFor(() => expect(held).toHaveLength(1));
    await act(async () =>
      held[0].answer({
        status: 200,
        body: {
          expense: { ...expense(5), status: 'posted' },
          policy: { action: 'auto-post', reason: 'ok' },
        },
      }),
    );
    // The toast AND the durable result (#259), which outlives the route.
    await waitFor(() =>
      expect(screen.getAllByText(/Posted ·/).length).toBeGreaterThanOrEqual(2),
    );
    await act(() => router.navigate('/settings'));
    expect(path(router)).toBe('/settings');
    expect(
      within(screen.getByRole('region', { name: 'Recent results' })).getByText(
        /Posted ·/,
      ),
    ).toBeInTheDocument();
  });

  it('a current 401 from a plain operation request signs out to the token gate', async () => {
    renderAt(['/books']);
    await fillNewExpense();
    await act(async () =>
      (await submitHeld()).answer({ status: 401, body: { message: 'no' } }),
    );
    expect(await screen.findByLabelText('API token')).toBeInTheDocument();
    expect(getToken()).toBeNull();
  });
});
