import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setToken } from '../auth';
import { buildRoutes } from './router';

/**
 * Issue #250 — the unsaved-changes guard through the PRODUCTION route tree
 * (buildRoutes → Root → AppLayout's provider + the single data-router
 * blocker). Sheet gestures (swipe, backdrop) and native refresh are proven
 * in the browser; this file pins the router/sign-out/save contracts.
 */

const ORG = {
  id: 1,
  country: 'EE',
  base_currency: null,
  vat_registered: true,
  vat_registration_kind: 'ordinary',
  input_vat_entitlement: 'full',
  input_vat_deduction_permille: null,
  org_type: 'company',
  created_at: 0,
  name: 'Acme OÜ',
  registry_code: null,
  vat_registration_number: null,
  iban: null,
};

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

let createStatus = 200;
const posts: unknown[] = [];

function mockApi() {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const json = (body: unknown, status = 200) =>
      Promise.resolve(new Response(JSON.stringify(body), { status }));
    if (/\/api\/expenses$/.test(url) && method === 'POST') {
      posts.push(JSON.parse(String(init?.body)));
      return createStatus === 200
        ? json({ ...expense(24), id: 24 })
        : json({ message: 'Fixture save failed' }, createStatus);
    }
    const one = /\/api\/expenses\/(\d+)$/.exec(url);
    if (one) return json(expense(Number(one[1])));
    if (url.includes('/api/expenses')) return json({ expenses: [] });
    if (/\/api\/organization$/.test(url)) return json(ORG);
    if (url.includes('/api/categories'))
      return json({
        categories: [{ key: 'office', label: 'Office', accountCode: 'X' }],
      });
    if (url.includes('/api/triage/needs-triage')) return json({ items: [] });
    if (url.includes('/api/approvals')) return json({ approvals: [] });
    if (url.includes('/api/sales-invoices')) return json({ invoices: [] });
    if (url.includes('/api/entities')) return json({ entities: [] });
    if (url.includes('/api/documents')) return json({ documents: [] });
    if (url.includes('/api/credit-notes')) return json({ credit_notes: [] });
    if (url.includes('/admin/settings')) return json({ settings: [] });
    return json([]);
  });
}

function renderAt(entries: string[]) {
  const router = createMemoryRouter(buildRoutes(), {
    initialEntries: entries,
    initialIndex: entries.length - 1,
  });
  render(<RouterProvider router={router} />);
  return router;
}

const path = (r: ReturnType<typeof renderAt>) => r.state.location.pathname;

async function dirtyOrgName() {
  const name = await screen.findByLabelText('Name');
  fireEvent.change(name, { target: { value: 'Unsaved OÜ' } });
  return name;
}

describe('unsaved-changes guard on the production routes (#250)', () => {
  beforeEach(() => {
    localStorage.clear();
    setToken('test-token');
    createStatus = 200;
    posts.length = 0;
    mockApi();
  });
  afterEach(() => vi.restoreAllMocks());

  it('section navigation asks; Keep keeps route and value, Discard proceeds', async () => {
    const router = renderAt(['/settings/organization']);
    await dirtyOrgName();

    void router.navigate('/books');
    fireEvent.click(
      await screen.findByRole('button', { name: 'Keep editing' }),
    );
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(path(router)).toBe('/settings/organization');
    expect(screen.getByLabelText('Name')).toHaveValue('Unsaved OÜ');

    void router.navigate('/books');
    fireEvent.click(await screen.findByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(path(router)).toBe('/books'));
  });

  it('Back (POP) is guarded, and Forward after a discard does not resurrect the draft', async () => {
    const router = renderAt(['/settings', '/settings/organization']);
    await dirtyOrgName();

    void router.navigate(-1);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Keep editing' }),
    );
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(path(router)).toBe('/settings/organization');
    expect(screen.getByLabelText('Name')).toHaveValue('Unsaved OÜ');

    void router.navigate(-1);
    fireEvent.click(await screen.findByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(path(router)).toBe('/settings'));

    // Forward at once — no waiting for the Settings chunk or an unmount: the
    // confirmed discard already remounted the form from the server snapshot.
    void router.navigate(1);
    await waitFor(() => expect(path(router)).toBe('/settings/organization'));
    expect(await screen.findByLabelText('Name')).toHaveValue('Acme OÜ');
  });

  it('a search-only change is not a leave; a clean form never asks', async () => {
    const router = renderAt(['/settings/organization']);
    await dirtyOrgName();
    await router.navigate('/settings/organization?tab=x');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByLabelText('Name')).toHaveValue('Unsaved OÜ');

    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'Acme OÜ' },
    });
    await router.navigate('/books');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(path(router)).toBe('/books');
  });

  it('same screen, another object: asks, and after Discard no sheet or draft follows to the new id', async () => {
    const router = renderAt(['/books/expenses/5']);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit draft…' }));
    const sheet = await screen.findByRole('dialog', {
      name: 'Edit draft expense',
    });
    const gross = await screen.findByLabelText(/Gross/);
    fireEvent.change(gross, { target: { value: '99.00' } });
    expect(sheet).toBeInTheDocument();

    void router.navigate('/books/expenses/6');
    fireEvent.click(await screen.findByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(path(router)).toBe('/books/expenses/6'));
    await waitFor(() =>
      expect(
        screen.queryByRole('dialog', { name: 'Edit draft expense' }),
      ).toBeNull(),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Edit draft…' }));
    expect(await screen.findByLabelText(/Gross/)).toHaveValue('10.00');
  });

  it('a successful create releases synchronously: one POST, navigates to the draft, no question', async () => {
    const router = renderAt(['/books']);
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
    fireEvent.click(screen.getByRole('button', { name: /Create expense/ }));
    await waitFor(() => expect(path(router)).toBe('/books/expenses/24'));
    expect(posts).toHaveLength(1);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('a failed create keeps the values and the guard', async () => {
    createStatus = 503;
    const router = renderAt(['/books']);
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
    fireEvent.click(screen.getByRole('button', { name: /Create expense/ }));
    await waitFor(() => expect(posts).toHaveLength(1));
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /Create expense/ }),
      ).not.toBeDisabled(),
    );
    expect(path(router)).toBe('/books');
    expect(screen.getByLabelText('Gross (€)')).toHaveValue('123.45');

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(await screen.findByRole('alertdialog')).toHaveTextContent(
      'New expense',
    );
  });

  it('explicit sign-out asks while a form is dirty; Discard signs out to the token gate', async () => {
    renderAt(['/settings/organization']);
    await dirtyOrgName();

    fireEvent.click(screen.getAllByRole('button', { name: 'Sign out' })[0]);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Keep editing' }),
    );
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(screen.getByLabelText('Name')).toHaveValue('Unsaved OÜ');

    fireEvent.click(screen.getAllByRole('button', { name: 'Sign out' })[0]);
    fireEvent.click(await screen.findByRole('button', { name: 'Discard' }));
    expect(await screen.findByLabelText('API token')).toBeInTheDocument();
    expect(screen.queryByLabelText('Name')).toBeNull();
  });
});
