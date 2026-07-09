import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  getNeedsTriageItems: vi.fn(),
  getPendingApprovals: vi.fn(),
  getExpense: vi.fn(),
  getExpenses: vi.fn(),
  getInvoices: vi.fn(),
  getEntities: vi.fn(),
  approveApproval: vi.fn(),
  rejectApproval: vi.fn(),
  fetchDocumentPreviewObjectUrl: vi.fn(),
  openSignedDocument: vi.fn(),
}));

import * as api from '../api';
import type { Approval } from '../api';
import { AppToaster } from '../ui/toast';
import { ApprovalScreen } from './ApprovalScreen';

const APPROVAL = (over: Partial<Approval> = {}): Approval => ({
  id: 7,
  object_type: 'expense',
  object_id: 214,
  status: 'pending',
  requested_by: 'system:policy',
  approved_by: null,
  rejected_reason: null,
  policy_reason: 'Voucher amount 8900 exceeds ceiling 5000',
  superseded_by: null,
  created_at: 100,
  resolved_at: null,
  ...over,
});

function renderAt(path: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const router = createMemoryRouter(
    [
      { path: '/inbox', element: <p>queue</p> },
      { path: '/inbox/approval/:id', element: <ApprovalScreen /> },
      { path: '/inbox/doc/:id', element: <p>doc detail</p> },
    ],
    { initialEntries: [path] },
  );
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

describe('ApprovalScreen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getNeedsTriageItems).mockResolvedValue([]);
    vi.mocked(api.getPendingApprovals).mockResolvedValue([
      APPROVAL(),
      APPROVAL({ id: 8, object_id: 215, created_at: 200 }),
    ]);
    vi.mocked(api.getExpense).mockResolvedValue({
      id: 214,
      document_id: 88,
      supplier_id: 3,
      category: 'software',
      gross_amount: 8900,
      vat_amount: 1605,
      currency: 'EUR',
      tax_point_date: '2026-07-03',
      status: 'pending',
      supplier_invoice_number: 'A-183',
      ai_confidence: 0.94,
    });
    vi.mocked(api.getExpenses).mockResolvedValue([]);
    vi.mocked(api.getInvoices).mockResolvedValue([]);
    vi.mocked(api.getEntities).mockResolvedValue([
      {
        id: 3,
        role: 'supplier',
        country: 'EE',
        name: 'Telia Eesti AS',
        goods_vs_services: null,
      },
    ]);
    vi.mocked(api.fetchDocumentPreviewObjectUrl).mockRejectedValue(
      new Error('no preview'),
    );
  });

  it('renders hero amount, subtitle and the N-of-M nav title', async () => {
    renderAt('/inbox/approval/7');
    expect(await screen.findByText('-89.00 €')).toBeInTheDocument();
    expect(screen.getByText(/Telia Eesti AS · software/)).toBeInTheDocument();
    expect(screen.getByText('1 of 2')).toBeInTheDocument();
  });

  it('renders the why-held box with the humanized numbers', async () => {
    renderAt('/inbox/approval/7');
    expect(await screen.findByText('Why held')).toBeInTheDocument();
    expect(
      screen.getByText(/89\.00 € above the 50\.00 € auto-post limit/),
    ).toBeInTheDocument();
  });

  it('renders the facts KV — VAT with implied rate, absolute date, confidence, invoice number', async () => {
    renderAt('/inbox/approval/7');
    expect(await screen.findByText('16.05 € (22%)')).toBeInTheDocument();
    expect(screen.getByText('03.07.2026')).toBeInTheDocument();
    expect(screen.getByText('0.94')).toBeInTheDocument();
    expect(screen.getByText('A-183')).toBeInTheDocument();
  });

  it('shows the document row when the expense has a linked document', async () => {
    renderAt('/inbox/approval/7');
    expect(await screen.findByText('Source document')).toBeInTheDocument();
  });

  it('renders a reconciliation_match approval safely (generic facts, no crash)', async () => {
    vi.mocked(api.getPendingApprovals).mockResolvedValue([
      APPROVAL({
        id: 9,
        object_type: 'reconciliation_match',
        object_id: 41,
        policy_reason: null,
      }),
    ]);
    renderAt('/inbox/approval/9');
    expect(await screen.findByText('Bank match')).toBeInTheDocument();
    expect(screen.getByText('Held for your approval')).toBeInTheDocument();
    expect(
      screen.getByText(/normally confirmed from the Bank section/),
    ).toBeInTheDocument();
  });

  it('shows the already-decided state for an id not in the pending list', async () => {
    renderAt('/inbox/approval/404');
    expect(await screen.findByText('Already decided')).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /back to inbox/i }),
    ).toHaveAttribute('href', '/inbox');
  });

  it('approves with one tap and auto-advances to the next pending item', async () => {
    // The approve ALSO drops item 7 from the pending list (as the real server
    // does), so the post-mutation refetch no longer contains this route. This
    // pins that `next` is computed from the queue as it was BEFORE the
    // mutation/invalidation — a compute-after regression would land on
    // /inbox (route no longer in the refetched queue), not /inbox/approval/8.
    vi.mocked(api.approveApproval).mockImplementation(async () => {
      vi.mocked(api.getPendingApprovals).mockResolvedValue([
        APPROVAL({ id: 8, object_id: 215, created_at: 200 }),
      ]);
      return { approval: APPROVAL({ status: 'approved' }) };
    });
    const router = renderAt('/inbox/approval/7');
    const btn = await screen.findByRole('button', { name: 'Approve · -89.00 €' });
    fireEvent.click(btn);
    await waitFor(() =>
      expect(api.approveApproval).toHaveBeenCalledWith(7, 'operator'),
    );
    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/inbox/approval/8'),
    );
  });

  it('rejects only with a non-empty reason and advances', async () => {
    vi.mocked(api.rejectApproval).mockResolvedValue({
      approval: APPROVAL({ status: 'rejected' }),
    });
    const router = renderAt('/inbox/approval/7');
    fireEvent.click(await screen.findByRole('button', { name: 'Reject…' }));
    const submit = await screen.findByRole('button', {
      name: 'Reject & return to draft',
    });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText(/why this should not be posted/i), {
      target: { value: 'Wrong supplier' },
    });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    await waitFor(() =>
      expect(api.rejectApproval).toHaveBeenCalledWith(7, 'Wrong supplier'),
    );
    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/inbox/approval/8'),
    );
  });

  it('stays on the screen when approve fails (server text surfaced)', async () => {
    vi.mocked(api.approveApproval).mockRejectedValue(
      new Error('Approval 7 is rejected, cannot approve'),
    );
    const router = renderAt('/inbox/approval/7');
    fireEvent.click(
      await screen.findByRole('button', { name: 'Approve · -89.00 €' }),
    );
    await waitFor(() => expect(api.approveApproval).toHaveBeenCalled());
    expect(router.state.location.pathname).toBe('/inbox/approval/7');
  });

  it('approves the last remaining item and returns to the queue', async () => {
    vi.mocked(api.getPendingApprovals).mockResolvedValue([APPROVAL()]);
    vi.mocked(api.approveApproval).mockResolvedValue({
      approval: APPROVAL({ status: 'approved' }),
    });
    const router = renderAt('/inbox/approval/7');
    fireEvent.click(
      await screen.findByRole('button', { name: 'Approve · -89.00 €' }),
    );
    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/inbox'),
    );
  });

  it('does not carry the previous reject reason to the next item', async () => {
    vi.mocked(api.rejectApproval).mockResolvedValue({
      approval: APPROVAL({ status: 'rejected' }),
    });
    const router = renderAt('/inbox/approval/7');
    fireEvent.click(await screen.findByRole('button', { name: 'Reject…' }));
    fireEvent.change(
      await screen.findByPlaceholderText(/why this should not be posted/i),
      { target: { value: 'Wrong supplier' } },
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Reject & return to draft' }),
    );
    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/inbox/approval/8'),
    );
    // Item 8's sheet must start CLEAN — a pre-filled reason from item 7
    // would let a stale justification land in item 8's audit trail.
    fireEvent.click(await screen.findByRole('button', { name: 'Reject…' }));
    const textarea = await screen.findByPlaceholderText(
      /why this should not be posted/i,
    );
    expect(textarea).toHaveValue('');
    expect(
      screen.getByRole('button', { name: 'Reject & return to draft' }),
    ).toBeDisabled();
  });

  it('shows the approve receipt WITHOUT an Undo action (posting is final)', async () => {
    vi.mocked(api.approveApproval).mockResolvedValue({
      approval: APPROVAL({ status: 'approved' }),
    });
    render(<AppToaster />);
    const router = renderAt('/inbox/approval/7');
    fireEvent.click(
      await screen.findByRole('button', { name: 'Approve · -89.00 €' }),
    );
    expect(
      await screen.findByText('Approved & posted · -89.00 €'),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/inbox/approval/8'),
    );
    expect(
      screen.queryByRole('button', { name: 'Undo' }),
    ).not.toBeInTheDocument();
  });
});
