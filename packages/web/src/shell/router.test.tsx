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
    // getEntity(id) — single Entity (with identifiers), not list-wrapped.
    if (/\/api\/entities\/\d+$/.test(url))
      return json({
        id: 5,
        name: 'Mari Maasikas',
        role: 'employee',
        country: 'EE',
        goods_vs_services: null,
        identifiers: [],
      });
    if (url.includes('/api/entities')) return json({ entities: [] });
    if (url.includes('/admin/settings')) return json({ settings: [] });
    if (url.includes('/api/policy-config'))
      return json({
        auto_post_amount_ceiling: 0,
        auto_post_min_confidence: 0,
        unknown_supplier_requires_approval: false,
        always_approve_operations: [],
      });
    if (url.includes('/api/mailbox/connectors')) return json([]);
    if (url.includes('/api/device-enrollments'))
      return json({
        apiBaseUrl: 'https://api.example.com',
        enrollmentToken: 'tok',
        expiresAt: new Date().toISOString(),
      });
    // getOrganization() — checked before /api/organization/period-config
    // below so the bare org GET doesn't fall through to the [] default.
    if (/\/api\/organization$/.test(url))
      return json({
        id: 1,
        country: 'EE',
        base_currency: null,
        vat_registered: true,
        org_type: 'company',
        created_at: 0,
        name: 'Acme OÜ',
        vat_registration_number: 'EE123456789',
        iban: null,
      });
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

  it('mounts SettingsScreen (hub) at /settings', async () => {
    renderAt('/settings');
    expect(
      await screen.findByRole('heading', { name: 'Settings' }),
    ).toBeInTheDocument();
  });

  it('mounts OrganizationScreen at /settings/organization', async () => {
    renderAt('/settings/organization');
    // ScreenHeader renders the title as a plain span, not an h1 — assert text.
    expect(await screen.findByText('Organization')).toBeInTheDocument();
  });

  it('mounts EntitiesScreen at /settings/entities', async () => {
    renderAt('/settings/entities');
    expect(
      await screen.findByRole('heading', { name: 'Entities' }),
    ).toBeInTheDocument();
  });

  it('mounts EntityScreen at /settings/entities/:id', async () => {
    renderAt('/settings/entities/5');
    // Skeleton-or-card: either the pending skeleton or the resolved card's
    // name proves EntityScreen (not a 404/blank route) mounted.
    await waitFor(() =>
      expect(screen.getByText('Mari Maasikas')).toBeInTheDocument(),
    );
  });

  it('mounts CategoriesScreen at /settings/categories', async () => {
    renderAt('/settings/categories');
    expect(await screen.findByText('Categories')).toBeInTheDocument();
  });

  it('mounts PolicyScreen at /settings/policy', async () => {
    renderAt('/settings/policy');
    expect(await screen.findByText('Posting policy')).toBeInTheDocument();
  });

  it('mounts MailboxScreen at /settings/mailbox', async () => {
    renderAt('/settings/mailbox');
    expect(await screen.findByText('Mail intake')).toBeInTheDocument();
  });

  it('mounts LlmScreen at /settings/llm', async () => {
    renderAt('/settings/llm');
    expect(await screen.findByText('AI models')).toBeInTheDocument();
  });

  it.each([
    ['/org', '/settings/organization'],
    ['/entities', '/settings/entities'],
    ['/categories', '/settings/categories'],
  ])('redirects legacy %s to %s', (from, to) => {
    const router = renderAt(from);
    expect(router.state.location.pathname).toBe(to);
  });

  it('redirects legacy /enroll to /settings/enroll', async () => {
    const router = renderAt('/enroll');
    expect(router.state.location.pathname).toBe('/settings/enroll');
    // Settle EnrollScreen's mount-time enrollment + QR generation inside the
    // test (its state lands async — unawaited it trips the act() warning).
    expect(
      await screen.findByAltText('Enrollment QR code'),
    ).toBeInTheDocument();
  });

  it('redirects the hub-level ?tab=app bookmark to /settings/llm', async () => {
    const router = renderAt('/settings?tab=app');
    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/settings/llm'),
    );
  });

  it('rescues the OAuth-return redirect: /?mailbox=connected → /settings/mailbox with the param preserved', async () => {
    const router = renderAt('/?mailbox=connected');
    expect(router.state.location.pathname).toBe('/settings/mailbox');
    expect(await screen.findByText('Mail intake')).toBeInTheDocument();
    // The param survived the redirect: MailboxScreen consumed it (its
    // "Mailbox connected" toast fires only when ?mailbox=connected arrived),
    // then stripped it so F5 doesn't replay the banner.
    expect(await screen.findByText('Mailbox connected')).toBeInTheDocument();
    expect(router.state.location.search).toBe('');
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
