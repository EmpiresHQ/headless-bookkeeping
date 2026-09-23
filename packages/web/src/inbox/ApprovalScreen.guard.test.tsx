import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ButtonHTMLAttributes } from 'react';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  getNeedsTriageItems: vi.fn(),
  getPendingApprovals: vi.fn(),
  getInvoices: vi.fn(),
  getEntities: vi.fn(),
  approveApproval: vi.fn(),
  getMatchFacts: vi.fn(),
}));

// The button's `disabled` is only the first gate. Render it WITHOUT the
// attribute so a click reaches the handler, which must refuse on its own
// (issue #256: "enforce in handler as well as button").
vi.mock('../ui/Button', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ui/Button')>()),
  Button: ({
    disabled,
    busy: _busy,
    variant: _variant,
    ...rest
  }: ButtonHTMLAttributes<HTMLButtonElement> & {
    busy?: boolean;
    variant?: string;
  }) => <button type="button" data-gated={disabled ? 'yes' : 'no'} {...rest} />,
}));

import * as api from '../api';
import { UnsavedChangesProvider } from '../lib/unsavedChanges';
import { ApprovalScreen } from './ApprovalScreen';

const APPROVAL = {
  id: 9,
  object_type: 'reconciliation_match',
  object_id: 41,
  status: 'pending',
  requested_by: 'system:policy',
  approved_by: null,
  rejected_reason: null,
  policy_reason: null,
  superseded_by: null,
  created_at: 100,
  resolved_at: null,
};

function renderAt(path: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const router = createMemoryRouter(
    [
      { path: '/inbox', element: <p>queue</p> },
      { path: '/inbox/approval/:id', element: <ApprovalScreen /> },
    ],
    { initialEntries: [path] },
  );
  render(
    <QueryClientProvider client={client}>
      <UnsavedChangesProvider onUnauthorized={() => undefined}>
        <RouterProvider router={router} />
      </UnsavedChangesProvider>
    </QueryClientProvider>,
  );
}

describe('ApprovalScreen — bank-match approve handler guard (issue #256)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getNeedsTriageItems).mockResolvedValue([]);
    vi.mocked(api.getPendingApprovals).mockResolvedValue([APPROVAL]);
    vi.mocked(api.getInvoices).mockResolvedValue([]);
    vi.mocked(api.getEntities).mockResolvedValue([]);
  });

  it('a click while the facts are unavailable sends nothing', async () => {
    vi.mocked(api.getMatchFacts).mockRejectedValue(new Error('facts down'));
    renderAt('/inbox/approval/9');
    await screen.findByText('facts down');
    const approve = screen.getByRole('button', { name: 'Approve match' });
    expect(approve).toHaveAttribute('data-gated', 'yes');
    fireEvent.click(approve);
    // Give a (wrongly) started operation every chance to call out.
    await new Promise((r) => setTimeout(r, 20));
    expect(api.approveApproval).not.toHaveBeenCalled();
  });

  it('a click on an unidentified target sends nothing', async () => {
    vi.mocked(api.getMatchFacts).mockResolvedValue({
      matchId: 41,
      status: 'draft',
      matchType: 'exact',
      signal: null,
      amountMatched: 5000,
      baseCurrency: 'EUR',
      bankTransaction: {
        id: 1,
        statementId: 2,
        transactionDate: '2026-07-10',
        description: 'x',
        amount: 5000,
        currency: 'EUR',
        sourceAmount: null,
        sourceCurrency: null,
        counterpartyIban: null,
        counterpartyDescriptor: null,
        reference: null,
        status: 'open',
      },
      line: {
        activeAllocatedBase: 0,
        activeCashBase: 0,
        otherDraftCount: 0,
        otherDraftAllocatedBase: 0,
      },
      target: {
        kind: 'unidentified',
        advanceKind: null,
        objectId: null,
        objectLabel: 'Unidentified object',
        counterpartyName: null,
        grossAmount: null,
        currency: null,
        voucherRemaining: 5000,
        advance: null,
      },
    });
    renderAt('/inbox/approval/9');
    await screen.findByText('Unidentified object');
    fireEvent.click(screen.getByRole('button', { name: 'Approve match' }));
    await new Promise((r) => setTimeout(r, 20));
    expect(api.approveApproval).not.toHaveBeenCalled();
  });

  it('control: with valid facts the same click does approve', async () => {
    vi.mocked(api.approveApproval).mockResolvedValue({
      approval: { ...APPROVAL, status: 'approved' },
    });
    vi.mocked(api.getMatchFacts).mockResolvedValue({
      matchId: 41,
      status: 'draft',
      matchType: 'exact',
      signal: null,
      amountMatched: 5000,
      baseCurrency: 'EUR',
      bankTransaction: {
        id: 1,
        statementId: 2,
        transactionDate: '2026-07-10',
        description: 'x',
        amount: 5000,
        currency: 'EUR',
        sourceAmount: null,
        sourceCurrency: null,
        counterpartyIban: null,
        counterpartyDescriptor: null,
        reference: null,
        status: 'open',
      },
      line: {
        activeAllocatedBase: 0,
        activeCashBase: 0,
        otherDraftCount: 0,
        otherDraftAllocatedBase: 0,
      },
      target: {
        kind: 'sales_invoice',
        advanceKind: null,
        objectId: 3,
        objectLabel: 'INV-1',
        counterpartyName: null,
        grossAmount: 5000,
        currency: 'EUR',
        voucherRemaining: 5000,
        advance: null,
      },
    });
    renderAt('/inbox/approval/9');
    await screen.findByText('INV-1 ›');
    fireEvent.click(screen.getByRole('button', { name: 'Approve match' }));
    await waitFor(() =>
      expect(api.approveApproval).toHaveBeenCalledWith(9, 'operator'),
    );
  });
});
