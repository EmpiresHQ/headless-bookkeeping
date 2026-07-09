import { render, screen, waitFor } from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setToken } from '../auth';
import { buildRoutes } from './router';

function renderAt(path: string) {
  const router = createMemoryRouter(buildRoutes(), { initialEntries: [path] });
  render(<RouterProvider router={router} />);
  return router;
}

/** The new Inbox/Books screens fetch on mount; route JSON per endpoint so any
 *  screen the router lands on renders without network noise. Specific
 *  (single-object) paths are checked before their general (list) prefix. */
function mockApiFetch() {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    const json = (body: unknown) =>
      Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    if (url.includes('/api/triage/needs-triage')) return json({ items: [] });
    if (url.includes('/api/approvals/pending')) return json({ approvals: [] });
    if (url.includes('/api/approvals')) return json({ approvals: [] });
    // getExpense(id) — single ExpenseDetail, not list-wrapped.
    if (/\/api\/expenses\/\d+$/.test(url))
      return json({
        id: 5,
        document_id: null,
        supplier_id: null,
        category: 'other',
        gross_amount: 0,
        vat_amount: 0,
        currency: 'EUR',
        tax_point_date: '2026-01-01',
        status: 'draft',
        supplier_invoice_number: null,
        ai_confidence: null,
        claimant_id: null,
        created_at: Date.now(),
      });
    if (url.includes('/api/expenses')) return json({ expenses: [] });
    if (url.includes('/api/sales-invoices')) return json({ invoices: [] });
    if (url.includes('/api/entities')) return json({ entities: [] });
    // getKmd(id) — minimal KmdDeclaration, all seven rows present.
    if (/\/api\/reporting-periods\/\d+\/kmd$/.test(url))
      return json({
        reporting_period_id: 7,
        period_name: '2026-07',
        start_date: '2026-07-01',
        end_date: '2026-07-31',
        row1_base_24: 0,
        row2_base_reduced: 0,
        row3_base_zero: 0,
        row4_output_vat: 0,
        row5_input_vat: 0,
        row6_intra_eu_acquisition: 0,
        row7_other_acquisition: 0,
        net_vat_due: 0,
        vd_intra_eu_services: 0,
        review_flags: [],
      });
    // getSubmissionState(id)
    if (/\/api\/reporting-periods\/\d+\/submission-state$/.test(url))
      return json({
        status: 'not_started',
        lastExternalRef: null,
        submissionCount: 0,
        history: [],
      });
    // getPeriodWarnings(id)
    if (/\/api\/reporting-periods\/\d+\/warnings$/.test(url))
      return json({ warnings: [] });
    // getPeriodConfig()
    if (url.includes('/api/organization/period-config'))
      return json({
        frequency_options: ['monthly'],
        default_frequency: 'monthly',
      });
    if (url.includes('/api/reporting-periods'))
      return json({ reportingPeriods: [] });
    if (url.includes('/api/documents/')) return json({});
    if (url.includes('/api/documents')) return json({ documents: [] });
    if (url.includes('/api/credit-notes/')) return json({});
    if (url.includes('/api/credit-notes')) return json({ credit_notes: [] });
    if (url.includes('/api/categories')) return json({ categories: [] });
    return json([]);
  });
}

describe('router', () => {
  beforeEach(() => {
    localStorage.clear();
    setToken('test-token');
    mockApiFetch();
  });
  afterEach(() => vi.restoreAllMocks());

  it('shows the token gate when no token is stored', () => {
    localStorage.clear();
    renderAt('/inbox');
    expect(
      screen.getByRole('heading', { name: /api token/i }),
    ).toBeInTheDocument();
  });

  it('redirects / to /inbox and renders the new queue screen', async () => {
    const router = renderAt('/');
    expect(router.state.location.pathname).toBe('/inbox');
    expect(
      await screen.findByRole('heading', { name: 'Inbox' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /^All$/ })).toBeInTheDocument();
  });

  it('redirects legacy /intake?expand=5 all the way to the triage detail route', async () => {
    const router = renderAt('/intake?expand=5');
    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/inbox/doc/5'),
    );
  });

  it('mounts ApprovalScreen at /inbox/approval/:id', async () => {
    renderAt('/inbox/approval/7');
    // No approval with id 7 in the empty mocked list — the "already
    // decided" state proves ApprovalScreen (not a 404/blank route) mounted.
    expect(await screen.findByText('Already decided')).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /back to inbox/i }),
    ).toHaveAttribute('href', '/inbox');
  });

  it('redirects legacy /approvals to the approvals segment', () => {
    const router = renderAt('/approvals');
    expect(router.state.location.pathname).toBe('/inbox');
    expect(router.state.location.search).toContain('seg=approvals');
  });

  it.each([
    ['/expenses', 'seg=expenses'],
    ['/invoices', 'seg=invoices'],
    ['/documents', 'seg=documents'],
    ['/credit-notes', 'seg=credit-notes'],
  ])('redirects legacy %s to /books?%s', (from, expectedSearch) => {
    const router = renderAt(from);
    expect(router.state.location.pathname).toBe('/books');
    expect(router.state.location.search).toContain(expectedSearch);
  });

  it('mounts BooksScreen at /books', async () => {
    renderAt('/books');
    expect(
      await screen.findByRole('heading', { name: 'Books' }),
    ).toBeInTheDocument();
  });

  it('mounts ExpenseScreen at /books/expenses/:id', async () => {
    renderAt('/books/expenses/5');
    expect(await screen.findByText('Expense')).toBeInTheDocument();
  });

  it('mounts CreditNoteCreateScreen at /books/credit-notes/new', async () => {
    renderAt('/books/credit-notes/new');
    expect(await screen.findByText('New credit note')).toBeInTheDocument();
  });

  it('mounts ReportsScreen at /reports', async () => {
    renderAt('/reports');
    expect(
      await screen.findByRole('heading', { name: 'Reports' }),
    ).toBeInTheDocument();
  });

  it('mounts PeriodScreen at /reports/periods/:id', async () => {
    renderAt('/reports/periods/7');
    // The mocked periods list is empty — the honest "does not exist" state
    // proves PeriodScreen (not a 404/blank route) mounted.
    expect(
      await screen.findByText('This period does not exist'),
    ).toBeInTheDocument();
  });

  it('mounts SubmissionsScreen at /reports/periods/:id/submissions', async () => {
    renderAt('/reports/periods/7/submissions');
    expect(await screen.findByText('Filing')).toBeInTheDocument();
  });

  it.each([
    ['/kmd', '/reports'],
    ['/periods', '/reports'],
  ])('redirects legacy %s to %s', (from, to) => {
    const router = renderAt(from);
    expect(router.state.location.pathname).toBe(to);
  });

  it('renders legacy section tabs at /settings', () => {
    renderAt('/settings');
    expect(
      screen.getByRole('tab', { name: 'Organization' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Entities' })).toBeInTheDocument();
  });

  it('renders the new Bank statements screen at /bank', async () => {
    renderAt('/bank');
    expect(
      await screen.findByRole('heading', { name: 'Bank' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Import' })).toHaveAttribute(
      'href',
      '/bank/import',
    );
  });
});
