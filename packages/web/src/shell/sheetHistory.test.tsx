import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setToken } from '../auth';
import { buildRoutes } from './router';

/**
 * Issue #267 — the explicit Close and the Back/Forward rule for modal layers
 * through the PRODUCTION route tree (the single blocker in AppLayout's
 * provider). While a layer is open a history traversal closes the TOP layer
 * through its own guards and the route stays; sheets never write history,
 * so after a close the very next Back leaves the route (no empty hops).
 * Browser-level Back from a directly entered first entry leaves the
 * document and never reaches the router — not claimed here.
 */

const expense = (id: number) => ({
  id,
  document_id: null,
  supplier_id: null,
  category: 'office',
  gross_amount: 12345,
  vat_amount: 2226,
  currency: 'EUR',
  tax_point_date: '2026-09-01',
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

let held: { url: string; answer: (r: Reply) => void }[] = [];

function mockApi() {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (method !== 'GET') {
      return new Promise<Response>((resolve) => {
        held.push({ url, answer: (r) => resolve(json(r)) });
      });
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

function renderAt(entries: string[], index = entries.length - 1) {
  const router = createMemoryRouter(buildRoutes(), {
    initialEntries: entries,
    initialIndex: index,
  });
  render(<RouterProvider router={router} />);
  return router;
}

type Router = ReturnType<typeof renderAt>;
const path = (r: Router) => r.state.location.pathname;

const MENU = 'Add to the books';
const dialog = (name: string) => screen.queryByRole('dialog', { name });
/** A sheet is gone once Radix unmounts its closing content. */
const expectClosed = (name: string) =>
  waitFor(() => expect(dialog(name)).toBeNull());

async function openMenu() {
  fireEvent.click(await screen.findByRole('button', { name: MENU }));
  return screen.findByRole('dialog', { name: MENU });
}

async function openNewExpense() {
  await openMenu();
  fireEvent.click(screen.getByText('New expense'));
  const sheet = await screen.findByRole('dialog', { name: 'New expense' });
  await screen.findByRole('option', { name: 'Office' });
  return sheet;
}

function typeGross(value: string) {
  fireEvent.change(screen.getByLabelText('Gross (€)'), {
    target: { value },
  });
}

async function back(router: Router) {
  await act(async () => {
    await router.navigate(-1);
  });
}

describe('sheets and Back/Forward on the production routes (#267)', () => {
  beforeEach(() => {
    localStorage.clear();
    setToken('test-token');
    held = [];
    mockApi();
  });
  afterEach(() => {
    held.forEach((h) => h.answer({ status: 500, body: {} }));
    vi.restoreAllMocks();
  });

  it('clean menu: Back closes it and stays; the next Back leaves the route', async () => {
    const router = renderAt(['/settings', '/books']);
    await openMenu();

    await back(router);
    await expectClosed(MENU);
    expect(path(router)).toBe('/books');

    await back(router);
    await waitFor(() => expect(path(router)).toBe('/settings'));
  });

  it('menu → New expense handoff: Back closes the form (no menu ghost), then leaves', async () => {
    const router = renderAt(['/settings', '/books']);
    await openNewExpense();
    await expectClosed(MENU);

    await back(router);
    await expectClosed('New expense');
    expect(dialog(MENU)).toBeNull();
    expect(path(router)).toBe('/books');

    await back(router);
    await waitFor(() => expect(path(router)).toBe('/settings'));
  });

  it('the explicit Close closes a clean sheet; one Back then leaves (no empty history hop)', async () => {
    const router = renderAt(['/settings', '/books']);
    const sheet = await openNewExpense();
    const close = within(sheet).getByRole('button', { name: 'Close' });
    expect(close).toHaveAttribute('type', 'button');

    fireEvent.click(close);
    await expectClosed('New expense');
    expect(path(router)).toBe('/books');

    await back(router);
    await waitFor(() => expect(path(router)).toBe('/settings'));
  });

  it('dirty: Back asks; Keep keeps sheet, value and route; Discard closes the sheet only', async () => {
    const router = renderAt(['/settings', '/books']);
    await openNewExpense();
    typeGross('77.00');

    await back(router);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Keep editing' }),
    );
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(dialog('New expense')).not.toBeNull();
    expect(screen.getByLabelText('Gross (€)')).toHaveValue('77.00');
    expect(path(router)).toBe('/books');

    await back(router);
    fireEvent.click(await screen.findByRole('button', { name: 'Discard' }));
    await expectClosed('New expense');
    expect(path(router)).toBe('/books');

    // Nothing is left dirty or open: the next Back is an ordinary leave.
    await back(router);
    await waitFor(() => expect(path(router)).toBe('/settings'));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('dirty Close button asks too; Discard closes, and reopening is fresh', async () => {
    renderAt(['/books']);
    const sheet = await openNewExpense();
    typeGross('77.00');

    fireEvent.click(within(sheet).getByRole('button', { name: 'Close' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Discard' }));
    await expectClosed('New expense');

    await openNewExpense();
    expect(screen.getByLabelText('Gross (€)')).toHaveValue('');
  });

  it('a Back while the discard question is open answers it "Keep" — only the top layer closes', async () => {
    const router = renderAt(['/settings', '/books']);
    await openNewExpense();
    typeGross('77.00');

    await back(router);
    await screen.findByRole('alertdialog');
    await back(router);
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(dialog('New expense')).not.toBeNull();
    expect(screen.getByLabelText('Gross (€)')).toHaveValue('77.00');
    expect(path(router)).toBe('/books');
  });

  it('Forward is consumed the same way: closes the top layer, then navigates', async () => {
    const router = renderAt(['/books', '/settings'], 0);
    await openMenu();

    await act(async () => {
      await router.navigate(1);
    });
    await expectClosed(MENU);
    expect(path(router)).toBe('/books');

    await act(async () => {
      await router.navigate(1);
    });
    await waitFor(() => expect(path(router)).toBe('/settings'));
  });

  it('two Backs before the guard answers dismiss the sheet once and keep the route', async () => {
    const router = renderAt(['/start', '/settings', '/books']);
    await openMenu();

    await act(async () => {
      void router.navigate(-1);
      void router.navigate(-1);
    });
    await expectClosed(MENU);
    expect(path(router)).toBe('/books');

    await back(router);
    await waitFor(() => expect(path(router)).toBe('/settings'));
  });

  it('a Back blocked for the menu never closes the sheet the menu handed off to', async () => {
    const router = renderAt(['/settings', '/books']);
    await openMenu();

    // The Back is blocked while the menu is on top; before the guard acts,
    // the menu hands off to the New expense sheet (a newer layer).
    act(() => {
      void router.navigate(-1);
      fireEvent.click(screen.getByText('New expense'));
    });
    await expectClosed(MENU);
    expect(
      await screen.findByRole('dialog', { name: 'New expense' }),
    ).toBeInTheDocument();
    expect(path(router)).toBe('/books');
  });

  it('while saving: Close is disabled, Back refused with a status; success → detail, Back → /books with no sheet', async () => {
    const router = renderAt(['/settings', '/books']);
    const sheet = await openNewExpense();
    fireEvent.change(screen.getByLabelText('Category'), {
      target: { value: 'office' },
    });
    typeGross('123.45');
    fireEvent.change(screen.getByLabelText('Tax point date'), {
      target: { value: '2026-09-01' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Create expense/ }));
    await waitFor(() => expect(held).toHaveLength(1));

    expect(within(sheet).getByRole('button', { name: 'Close' })).toBeDisabled();
    await back(router);
    expect(path(router)).toBe('/books');
    expect(dialog('New expense')).not.toBeNull();
    expect(
      await screen.findByText(/“New expense” is still saving/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).toBeNull();

    await act(async () => held[0].answer({ status: 200, body: expense(24) }));
    await waitFor(() => expect(path(router)).toBe('/books/expenses/24'));
    await expectClosed('New expense');

    await back(router);
    await waitFor(() => expect(path(router)).toBe('/books'));
    expect(dialog('New expense')).toBeNull();
    expect(dialog(MENU)).toBeNull();

    await back(router);
    await waitFor(() => expect(path(router)).toBe('/settings'));
  });
});
