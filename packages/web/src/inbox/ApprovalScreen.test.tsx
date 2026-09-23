import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
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
  getMatchFacts: vi.fn(),
  fetchDocumentPreviewObjectUrl: vi.fn(),
  openSignedDocument: vi.fn(),
}));

vi.mock('../queries/inbox', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../queries/inbox')>()),
  invalidateInbox: vi.fn(),
}));

import * as api from '../api';
import type { Approval, MatchFacts } from '../api';
import { HttpError } from '../auth';
import { invalidateInbox } from '../queries/inbox';
import { AppToaster } from '../ui/toast';
import { ApprovalScreen } from './ApprovalScreen';
import { UnsavedChangesProvider } from '../lib/unsavedChanges';
import { RESULT_LOG_KEY, ResultLogProvider } from '../lib/resultLog';
import { setToken } from '../auth';
import type { QueueRun } from './queueRun';

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

/** A staged bank match (issue #256): an incoming EUR line paying 600.00 of
 *  invoice INV-7001 (1000.00 open), split with another staged match. */
const FACTS = (over: Partial<MatchFacts> = {}): MatchFacts => ({
  matchId: 41,
  status: 'draft',
  matchType: 'partial',
  signal: 'invoice_number',
  amountMatched: 60000,
  baseCurrency: 'EUR',
  bankTransaction: {
    id: 501,
    statementId: 12,
    transactionDate: '2026-07-10',
    description: 'Payment INV-7001',
    amount: 100000,
    currency: 'EUR',
    sourceAmount: null,
    sourceCurrency: null,
    counterpartyIban: 'EE382200221020145685',
    counterpartyDescriptor: null,
    reference: 'RF-7001',
    status: 'open',
  },
  line: {
    activeAllocatedBase: 0,
    activeCashBase: 0,
    otherDraftCount: 1,
    otherDraftAllocatedBase: 40000,
  },
  target: {
    kind: 'sales_invoice',
    advanceKind: null,
    objectId: 77,
    objectLabel: 'INV-7001',
    counterpartyName: 'Acme OÜ',
    grossAmount: 100000,
    currency: 'EUR',
    voucherRemaining: 100000,
    advance: null,
  },
  ...over,
});

/** A facts KeyValue row by its label. */
const row = (label: string) => screen.getByText(label).parentElement;

const MATCH_APPROVAL = APPROVAL({
  id: 9,
  object_type: 'reconciliation_match',
  object_id: 41,
  policy_reason: null,
});

/** The queue run these tests process in (issue #253): opened from the
 *  approvals list, in its rendered order. `null` = single-item entry (deep link,
 *  Books). */
const QUEUE: QueueRun = {
  seg: 'approvals',
  members: ['/inbox/approval/8', '/inbox/approval/7'],
};

/** The last rendered client — lets a test drive a background refetch. */
let lastClient: QueryClient;

function renderAt(path: string, run: QueueRun | null = QUEUE) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  lastClient = client;
  const router = createMemoryRouter(
    [
      { path: '/inbox', element: <p>queue</p> },
      { path: '/inbox/approval/:id', element: <ApprovalScreen /> },
      { path: '/inbox/doc/:id', element: <p>doc detail</p> },
    ],
    {
      initialEntries: [{ pathname: path, state: run ? { hbkRun: run } : null }],
    },
  );
  render(
    <QueryClientProvider client={client}>
      <UnsavedChangesProvider onUnauthorized={() => undefined}>
        <ResultLogProvider>
          <RouterProvider router={router} />
        </ResultLogProvider>
      </UnsavedChangesProvider>
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
      claimant_id: null,
      created_at: 1751000000,
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
        tax_status: null,
      },
    ]);
    vi.mocked(api.fetchDocumentPreviewObjectUrl).mockRejectedValue(
      new Error('no preview'),
    );
  });

  it('renders hero amount, subtitle and the N-of-M nav title', async () => {
    renderAt('/inbox/approval/7');
    expect(await screen.findByText('−89.00 €')).toBeInTheDocument();
    expect(screen.getByText(/Telia Eesti AS · software/)).toBeInTheDocument();
    expect(screen.getByText('2 of 2')).toBeInTheDocument();
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

  it('shows a LoadError and disables Approve when the expense fetch fails — no blind approve', async () => {
    vi.mocked(api.getExpense).mockRejectedValueOnce(new Error('network down'));
    renderAt('/inbox/approval/7');
    expect(await screen.findByText('network down')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
    // Retry re-fetches — the beforeEach default (a valid expense) resolves
    // once the rejected-once mock is consumed.
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('−89.00 €')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Approve · −89.00 €' }),
    ).toBeEnabled();
  });

  it('shows an unavailable state and disables Approve when the invoice is absent from the settled list', async () => {
    vi.mocked(api.getPendingApprovals).mockResolvedValue([
      APPROVAL({ id: 10, object_type: 'sales_invoice', object_id: 999 }),
    ]);
    vi.mocked(api.getInvoices).mockResolvedValue([]); // settled — no match
    renderAt('/inbox/approval/10');
    expect(await screen.findByText('Facts unavailable')).toBeInTheDocument();
    expect(
      screen.getByText('The invoice could not be loaded'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
  });

  it('an unrecognised type offers no decision and claims no effect', async () => {
    vi.mocked(api.getPendingApprovals).mockResolvedValue([
      APPROVAL({ id: 11, object_type: 'payroll_run', object_id: 5 }),
    ]);
    renderAt('/inbox/approval/11', null);
    expect(
      await screen.findByText(/ask your bookkeeper or system operator/),
    ).toBeInTheDocument();
    const approve = screen.getByRole('button', { name: 'Approve' });
    const reject = screen.getByRole('button', { name: 'Reject…' });
    expect(approve).toBeDisabled();
    expect(reject).toBeDisabled();
    expect(screen.queryByText(/posts to the books/)).not.toBeInTheDocument();
    fireEvent.click(approve);
    fireEvent.click(reject);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(api.approveApproval).not.toHaveBeenCalled();
    expect(api.rejectApproval).not.toHaveBeenCalled();
  });

  describe('bank-match approval facts (issue #256)', () => {
    beforeEach(() => {
      vi.mocked(api.getPendingApprovals).mockResolvedValue([MATCH_APPROVAL]);
      vi.mocked(api.getMatchFacts).mockResolvedValue(FACTS());
      vi.mocked(api.approveApproval).mockResolvedValue({
        approval: { ...MATCH_APPROVAL, status: 'approved' },
      });
    });

    const approveBtn = () =>
      screen.getByRole('button', { name: 'Approve match' });

    it('shows the exact line, the business object, amounts with units and the meaning before deciding', async () => {
      renderAt('/inbox/approval/9', null);
      expect(
        await screen.findByText('10.07.2026 · Payment INV-7001'),
      ).toBeInTheDocument();
      expect(api.getMatchFacts).toHaveBeenCalledWith(41);
      // Bank line
      expect(screen.getByText('Payment INV-7001')).toBeInTheDocument();
      expect(screen.getByText('RF-7001')).toBeInTheDocument();
      expect(screen.getByText('EE382200221020145685')).toBeInTheDocument();
      // Target: business label linking to the Books object, no voucher id.
      expect(screen.getByRole('link', { name: 'INV-7001 ›' })).toHaveAttribute(
        'href',
        '/books/invoices/77',
      );
      expect(screen.getByText('Acme OÜ')).toBeInTheDocument();
      // A draft is not settled yet: conditional labels, not "booked".
      expect(screen.getByText('Would settle (EUR)')).toBeInTheDocument();
      expect(screen.queryByText(/booked\)/)).not.toBeInTheDocument();
      expect(
        screen.getByText('Partly settled — 400.00 € stays open'),
      ).toBeInTheDocument();
      // Actual cash vs the hypothetical after THIS approval; the other staged
      // match reserves nothing and is listed as not settled.
      expect(row('Line cash unallocated now (EUR)')).toHaveTextContent(
        '1000.00 €',
      );
      expect(row('Line cash unallocated if approved (EUR)')).toHaveTextContent(
        '400.00 €',
      );
      expect(
        screen.getByText(/Other staged matches on this line — not settled/),
      ).toBeInTheDocument();
      expect(screen.getByText('1 · 400.00 €')).toBeInTheDocument();
      // Exact amounts wrap, never truncate (390/320px review).
      for (const label of [
        'Object if approved',
        'Line cash unallocated if approved (EUR)',
      ])
        expect(row(label)?.lastElementChild).not.toHaveClass('truncate');
      expect(screen.getByText('1 · 400.00 €')).not.toHaveClass('truncate');
      expect(
        screen.getByText(
          'Approve settles the match immediately — undo via Unmatch in Bank',
        ),
      ).toBeInTheDocument();
      expect(
        screen.getByText(
          /pays invoice INV-7001 with 600\.00 € and books the settlement/,
        ),
      ).toBeInTheDocument();
      // No Bank decision detour from here (#252: no decided approval left in
      // Back history by a confirm elsewhere).
      expect(
        screen.queryByRole('link', { name: /bank/i }),
      ).not.toBeInTheDocument();
      expect(approveBtn()).toBeEnabled();
    });

    it('approves with a scoped receipt (not "posted") and leaves', async () => {
      render(<AppToaster />);
      const router = renderAt('/inbox/approval/9', null);
      await screen.findByText('10.07.2026 · Payment INV-7001');
      fireEvent.click(approveBtn());
      await waitFor(() =>
        expect(api.approveApproval).toHaveBeenCalledWith(9, 'operator'),
      );
      expect(
        await screen.findByText(
          'Match confirmed · settlement booked · 600.00 €',
        ),
      ).toBeInTheDocument();
      expect(screen.queryByText(/Approved & posted/)).not.toBeInTheDocument();
      await waitFor(() =>
        expect(router.state.location.pathname).toBe('/inbox'),
      );
    });

    it('keeps Approve off while the facts load', async () => {
      vi.mocked(api.getMatchFacts).mockReturnValue(new Promise(() => {}));
      renderAt('/inbox/approval/9', null);
      expect(
        await screen.findByRole('button', { name: 'Approve match' }),
      ).toBeDisabled();
      expect(
        screen.getByRole('button', { name: 'Reject match…' }),
      ).toBeEnabled();
    });

    it('shows a retryable error and keeps Approve off when the facts fail to load', async () => {
      vi.mocked(api.getMatchFacts).mockRejectedValue(new Error('facts down'));
      renderAt('/inbox/approval/9', null);
      expect(await screen.findByText('facts down')).toBeInTheDocument();
      expect(approveBtn()).toBeDisabled();
      vi.mocked(api.getMatchFacts).mockResolvedValue(FACTS());
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
      expect(
        await screen.findByText('10.07.2026 · Payment INV-7001'),
      ).toBeInTheDocument();
      await waitFor(() => expect(approveBtn()).toBeEnabled());
    });

    it('a deleted match (404) is final: nothing to approve', async () => {
      vi.mocked(api.getMatchFacts).mockRejectedValue(
        new HttpError(404, 'Reconciliation match 41 not found'),
      );
      renderAt('/inbox/approval/9', null);
      expect(
        await screen.findByText('Match no longer exists'),
      ).toBeInTheDocument();
      expect(approveBtn()).toBeDisabled();
    });

    it('refuses facts for a different match (wrong/stale identity)', async () => {
      vi.mocked(api.getMatchFacts).mockResolvedValue(FACTS({ matchId: 42 }));
      renderAt('/inbox/approval/9', null);
      expect(
        await screen.findByText(/not the one this approval decides/),
      ).toBeInTheDocument();
      expect(screen.queryByText('INV-7001 ›')).not.toBeInTheDocument();
      expect(approveBtn()).toBeDisabled();
    });

    it('refuses a malformed payload (missing amounts/currency) — the target kind alone never passes', async () => {
      const f = FACTS();
      vi.mocked(api.getMatchFacts).mockResolvedValue({
        ...f,
        target: { ...f.target, grossAmount: null, currency: null },
      });
      renderAt('/inbox/approval/9', null);
      expect(
        await screen.findByText(/could not be identified/),
      ).toBeInTheDocument();
      expect(approveBtn()).toBeDisabled();

      vi.mocked(api.getMatchFacts).mockResolvedValue({
        ...f,
        bankTransaction: { ...f.bankTransaction, currency: undefined },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
      expect(
        await screen.findByText(/bank line could not be read/),
      ).toBeInTheDocument();
      expect(approveBtn()).toBeDisabled();
    });

    it('an unidentified target shows the line but blocks Approve (no "prepayment" guess, no blind Bank detour)', async () => {
      const f = FACTS();
      vi.mocked(api.getMatchFacts).mockResolvedValue(
        FACTS({
          target: {
            ...f.target,
            kind: 'unidentified',
            objectId: null,
            objectLabel: 'Unidentified object',
            counterpartyName: null,
            grossAmount: null,
            currency: null,
          },
        }),
      );
      renderAt('/inbox/approval/9', null);
      expect(
        await screen.findByText(/matched object could not be identified/),
      ).toBeInTheDocument();
      expect(screen.getByText('Unidentified object')).toBeInTheDocument();
      expect(screen.queryByText(/prepayment|advance/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/decide in Bank/i)).not.toBeInTheDocument();
      expect(approveBtn()).toBeDisabled();
      expect(
        screen.getByRole('button', { name: 'Reject match…' }),
      ).toBeEnabled();
    });

    it('a failed re-check keeps the cached facts visible but turns Approve off until a re-check succeeds', async () => {
      renderAt('/inbox/approval/9', null);
      expect(
        await screen.findByText('10.07.2026 · Payment INV-7001'),
      ).toBeInTheDocument();
      expect(approveBtn()).toBeEnabled();

      vi.mocked(api.getMatchFacts).mockRejectedValue(new Error('gateway down'));
      await act(() =>
        lastClient.refetchQueries({
          queryKey: ['inbox', 'approval-match', 41],
        }),
      );
      expect(
        await screen.findByText(/Could not re-check this match — gateway down/),
      ).toBeInTheDocument();
      expect(screen.getAllByText('+1000.00 €')).toHaveLength(2);
      expect(approveBtn()).toBeDisabled();

      vi.mocked(api.getMatchFacts).mockResolvedValue(FACTS());
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
      await waitFor(() => expect(approveBtn()).toBeEnabled());
    });

    it('a 404 on re-check keeps the cached facts marked as gone and Approve off', async () => {
      renderAt('/inbox/approval/9', null);
      expect(
        await screen.findByText('10.07.2026 · Payment INV-7001'),
      ).toBeInTheDocument();
      vi.mocked(api.getMatchFacts).mockRejectedValue(
        new HttpError(404, 'Reconciliation match 41 not found'),
      );
      await act(() =>
        lastClient.refetchQueries({
          queryKey: ['inbox', 'approval-match', 41],
        }),
      );
      expect(
        await screen.findByText(/This match no longer exists/),
      ).toBeInTheDocument();
      expect(approveBtn()).toBeDisabled();
    });

    it('a converted foreign line states its original amount and the FX meaning', async () => {
      const f = FACTS();
      vi.mocked(api.getMatchFacts).mockResolvedValue(
        FACTS({
          bankTransaction: {
            ...f.bankTransaction,
            sourceAmount: 110000,
            sourceCurrency: 'USD',
          },
          target: { ...f.target, currency: 'USD', grossAmount: 110000 },
        }),
      );
      renderAt('/inbox/approval/9', null);
      expect(await screen.findByText('Original amount')).toBeInTheDocument();
      expect(screen.getAllByText('1100.00 USD')).toHaveLength(2);
      expect(screen.getByText(/converted from USD/)).toBeInTheDocument();
      // Nothing is converted client-side: no line remainder across units.
      expect(
        screen.queryByText(/Line cash unallocated/),
      ).not.toBeInTheDocument();
      // The allocation is the USD document at its booked rate — not cash.
      expect(
        screen.getByText('Would settle (EUR, at the document’s booked rate)'),
      ).toBeInTheDocument();
    });

    it('a prepayment shows WHICH advance from its record and its own meaning', async () => {
      const f = FACTS();
      vi.mocked(api.getMatchFacts).mockResolvedValue(
        FACTS({
          matchType: 'prepayment',
          amountMatched: 50000,
          target: {
            kind: 'prepayment',
            advanceKind: 'supplier',
            objectId: null,
            objectLabel: 'Supplier advance',
            counterpartyName: 'Parts AS',
            grossAmount: null,
            currency: null,
            voucherRemaining: 80000,
            advance: {
              date: '2026-06-01',
              originalBaseAmount: 80000,
              currency: 'EUR',
              fundingLine: {
                transactionDate: '2026-06-01',
                description: 'Deposit order 55',
                reference: null,
                amount: -80000,
                currency: 'EUR',
              },
              needsReview: false,
              taxTreatment: 'non_taxable_deposit',
              ownerResolved: true,
            },
          },
          bankTransaction: { ...f.bankTransaction, amount: -50000 },
        }),
      );
      render(<AppToaster />);
      renderAt('/inbox/approval/9', null);
      expect(await screen.findByText('Supplier advance')).toBeInTheDocument();
      expect(screen.getByText('Parts AS')).toBeInTheDocument();
      expect(screen.getByText('01.06.2026')).toBeInTheDocument();
      expect(
        screen.getByText('01.06.2026 · Deposit order 55 · −800.00 €'),
      ).toBeInTheDocument();
      expect(
        screen.getByText(
          /applies this bank line to the supplier advance of 01\.06\.2026/,
        ),
      ).toBeInTheDocument();
      expect(
        screen.getByText(/No settlement voucher is posted/),
      ).toBeInTheDocument();
      fireEvent.click(approveBtn());
      expect(
        await screen.findByText(
          'Match confirmed · applied to the advance · 500.00 €',
        ),
      ).toBeInTheDocument();
    });

    it.each([
      ['no resolved owner', { ownerResolved: false }, /no resolved owner/],
      ['an unverified balance', { needsReview: true }, /unverified/],
      [
        'an unclassified advance',
        { taxTreatment: 'unresolved' },
        /unclassified/,
      ],
    ])('blocks a prepayment with %s', async (_label, over, reason) => {
      vi.mocked(api.getMatchFacts).mockResolvedValue(
        FACTS({
          matchType: 'prepayment',
          target: {
            kind: 'prepayment',
            advanceKind: 'customer',
            objectId: null,
            objectLabel: 'Customer advance',
            counterpartyName: 'Acme OÜ',
            grossAmount: null,
            currency: null,
            voucherRemaining: 80000,
            advance: {
              date: '2026-06-01',
              originalBaseAmount: 80000,
              currency: 'EUR',
              fundingLine: null,
              needsReview: false,
              taxTreatment: 'taxable_supply',
              ownerResolved: true,
              ...over,
            },
          },
        }),
      );
      renderAt('/inbox/approval/9', null);
      expect(await screen.findByText(reason)).toBeInTheDocument();
      expect(approveBtn()).toBeDisabled();
    });

    it('an already-active match says nothing new is booked and approving only closes the request', async () => {
      vi.mocked(api.getMatchFacts).mockResolvedValue(
        FACTS({
          status: 'active',
          line: {
            activeAllocatedBase: 60000,
            activeCashBase: 60000,
            otherDraftCount: 0,
            otherDraftAllocatedBase: 0,
          },
          target: { ...FACTS().target, voucherRemaining: 40000 },
        }),
      );
      render(<AppToaster />);
      renderAt('/inbox/approval/9', null);
      expect(
        await screen.findByText(/already active .* nothing new is booked/),
      ).toBeInTheDocument();
      // The active match is already inside the remaining/line figures.
      expect(
        screen.getByText('Partly settled — 400.00 € stays open'),
      ).toBeInTheDocument();
      expect(screen.getByText('Settles (EUR)')).toBeInTheDocument();
      expect(
        screen.getByText('Line cash settled, incl. this match (EUR)'),
      ).toBeInTheDocument();
      expect(
        screen.queryByText(/unallocated if approved/),
      ).not.toBeInTheDocument();
      expect(
        screen.getByText(
          /Approve only closes this request · Reject is refused/,
        ),
      ).toBeInTheDocument();
      expect(
        screen.queryByText(/Approve settles the match/),
      ).not.toBeInTheDocument();
      // Verified active: the confirmation says the discard will be refused.
      fireEvent.click(screen.getByRole('button', { name: 'Reject match…' }));
      expect(
        await screen.findByText(
          /This match is already active, so it cannot be discarded here/,
        ),
      ).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Close' }));
      fireEvent.click(
        await screen.findByRole('button', { name: 'Close approval' }),
      );
      expect(
        await screen.findByText(
          'Approval closed — the match was already active',
        ),
      ).toBeInTheDocument();
    });

    it('an active status known only from cached facts is not presented as verified', async () => {
      vi.mocked(api.getMatchFacts).mockResolvedValue(
        FACTS({ status: 'active' }),
      );
      renderAt('/inbox/approval/9', null);
      expect(
        await screen.findByRole('button', { name: 'Close approval' }),
      ).toBeEnabled();
      vi.mocked(api.getMatchFacts).mockRejectedValue(new Error('gateway down'));
      await act(() =>
        lastClient.refetchQueries({
          queryKey: ['inbox', 'approval-match', 41],
        }),
      );
      expect(
        await screen.findByText(/Could not re-check this match — gateway down/),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: 'Approve match' }),
      ).toBeDisabled();
      fireEvent.click(screen.getByRole('button', { name: 'Reject match…' }));
      const sheet = await screen.findByRole('dialog', {
        name: 'Reject bank match',
      });
      expect(sheet).toHaveTextContent(
        /When last loaded, this match was already active/,
      );
      expect(sheet).not.toHaveTextContent(/This match is already active/);
    });

    it('rejecting stays available without facts and is scoped as discarding the staged match', async () => {
      vi.mocked(api.getMatchFacts).mockRejectedValue(new Error('facts down'));
      vi.mocked(api.rejectApproval).mockResolvedValue({
        approval: { ...MATCH_APPROVAL, status: 'rejected' },
      });
      render(<AppToaster />);
      const router = renderAt('/inbox/approval/9', null);
      await screen.findByText('facts down');
      fireEvent.click(screen.getByRole('button', { name: 'Reject match…' }));
      // Undoing a proposed link, not an object correction: nothing returns
      // to draft and no posting is implied.
      expect(
        await screen.findByRole('dialog', { name: 'Reject bank match' }),
      ).toHaveTextContent(/discards this proposed match/);
      expect(screen.queryByText(/goes back to draft/)).not.toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: 'Reject & return to draft' }),
      ).not.toBeInTheDocument();
      fireEvent.change(
        screen.getByPlaceholderText(/why this match is wrong/i),
        {
          target: { value: 'Wrong invoice' },
        },
      );
      fireEvent.click(
        screen.getByRole('button', { name: 'Reject & discard match' }),
      );
      await waitFor(() =>
        expect(api.rejectApproval).toHaveBeenCalledWith(9, 'Wrong invoice'),
      );
      expect(
        await screen.findByText('Rejected — the staged match was discarded'),
      ).toBeInTheDocument();
      await waitFor(() =>
        expect(router.state.location.pathname).toBe('/inbox'),
      );
    });
  });

  it('shows the already-decided state for an id not in the pending list', async () => {
    renderAt('/inbox/approval/404');
    expect(await screen.findByText('No pending approval')).toBeInTheDocument();
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
    const btn = await screen.findByRole('button', {
      name: 'Approve · −89.00 €',
    });
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
    fireEvent.change(
      screen.getByPlaceholderText(/why this should not be posted/i),
      {
        target: { value: 'Wrong supplier' },
      },
    );
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
      await screen.findByRole('button', { name: 'Approve · −89.00 €' }),
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
      await screen.findByRole('button', { name: 'Approve · −89.00 €' }),
    );
    await waitFor(() => expect(router.state.location.pathname).toBe('/inbox'));
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

  it('navigates to the next item WHILE the inbox invalidation is still pending (no "No pending approval" flash) — approve', async () => {
    let release!: () => void;
    vi.mocked(invalidateInbox).mockReturnValue(
      new Promise<void>((r) => (release = r)),
    );
    vi.mocked(api.approveApproval).mockResolvedValue({
      approval: APPROVAL({ status: 'approved' }),
    });
    try {
      const router = renderAt('/inbox/approval/7');
      fireEvent.click(
        await screen.findByRole('button', { name: 'Approve · −89.00 €' }),
      );
      await waitFor(() =>
        expect(router.state.location.pathname).not.toBe('/inbox/approval/7'),
      );
      expect(router.state.location.pathname).toBe('/inbox/approval/8');
    } finally {
      // Always release, even if an assertion above throws — otherwise the
      // never-resolved invalidateInbox promise leaks into later tests.
      release();
    }
  });

  it('navigates to the next item WHILE the inbox invalidation is still pending (no "No pending approval" flash) — reject', async () => {
    let release!: () => void;
    vi.mocked(invalidateInbox).mockReturnValue(
      new Promise<void>((r) => (release = r)),
    );
    vi.mocked(api.rejectApproval).mockResolvedValue({
      approval: APPROVAL({ status: 'rejected' }),
    });
    try {
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
        expect(router.state.location.pathname).not.toBe('/inbox/approval/7'),
      );
      expect(router.state.location.pathname).toBe('/inbox/approval/8');
    } finally {
      // Always release, even if an assertion above throws — otherwise the
      // never-resolved invalidateInbox promise leaks into later tests.
      release();
    }
  });

  it('shows the approve receipt WITHOUT an Undo action (posting is final)', async () => {
    vi.mocked(api.approveApproval).mockResolvedValue({
      approval: APPROVAL({ status: 'approved' }),
    });
    render(<AppToaster />);
    const router = renderAt('/inbox/approval/7');
    fireEvent.click(
      await screen.findByRole('button', { name: 'Approve · −89.00 €' }),
    );
    expect(
      await screen.findByText('Approved & posted · −89.00 €'),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/inbox/approval/8'),
    );
    expect(
      screen.queryByRole('button', { name: 'Undo' }),
    ).not.toBeInTheDocument();
  });

  describe('processing context (issue #253)', () => {
    beforeEach(() => {
      vi.mocked(api.approveApproval).mockResolvedValue({
        approval: APPROVAL({ status: 'approved' }),
      });
    });

    it('deep link is a single item: no queue count, approve returns to the Inbox', async () => {
      const router = renderAt('/inbox/approval/7', null);
      expect(
        await screen.findByText('Single item · returns to Inbox'),
      ).toBeInTheDocument();
      expect(screen.getByText('‹ Back').parentElement).toHaveTextContent(
        /^‹ BackApproval$/,
      );
      expect(screen.queryByText(/\d+ of \d+/)).not.toBeInTheDocument();
      fireEvent.click(
        await screen.findByRole('button', { name: 'Approve · −89.00 €' }),
      );
      await waitFor(() =>
        expect(router.state.location.pathname).toBe('/inbox'),
      );
    });

    it('an approvals run ignores a failing triage list and never advances into triage', async () => {
      vi.mocked(api.getNeedsTriageItems).mockRejectedValue(
        new Error('triage down'),
      );
      const router = renderAt('/inbox/approval/8');
      expect(await screen.findByText('1 of 2')).toBeInTheDocument();
      expect(
        screen.getByText('Approvals queue · next item follows'),
      ).toBeInTheDocument();
      fireEvent.click(await screen.findByRole('button', { name: /^Approve/ }));
      await waitFor(() =>
        expect(router.state.location.pathname).toBe('/inbox/approval/7'),
      );
    });
  });

  describe('durable receipts (issue #259)', () => {
    type Stored = {
      entries: {
        action: string;
        title: string;
        outcome: string;
        tone: string;
        links: { to: string }[];
      }[];
    };
    const stored = (): Stored =>
      JSON.parse(sessionStorage.getItem(RESULT_LOG_KEY) ?? '{"entries":[]}');
    beforeEach(() => {
      sessionStorage.clear();
      setToken('t');
    });

    it('a failed approve is recorded as NOT confirmed (never as posted); rejecting then supersedes it', async () => {
      vi.mocked(api.approveApproval).mockRejectedValue(
        new Error('503 Service Unavailable'),
      );
      vi.mocked(api.rejectApproval).mockResolvedValue({} as never);
      renderAt('/inbox/approval/7');
      fireEvent.click(
        await screen.findByRole('button', { name: 'Approve · −89.00 €' }),
      );
      await waitFor(() => expect(stored().entries[0]?.tone).toBe('error'));
      const [failed] = stored().entries;
      expect(failed).toMatchObject({
        action: 'Approve',
        title: 'Expense #214',
      });
      expect(failed.outcome).toMatch(/Approving was not confirmed/);
      expect(failed.outcome).not.toMatch(/posted ·|Approved & posted/);
      expect(failed.links.map((l) => l.to)).toEqual([
        '/inbox/approval/7',
        '/books/expenses/214',
      ]);

      fireEvent.click(screen.getByRole('button', { name: 'Reject…' }));
      fireEvent.change(
        await screen.findByPlaceholderText('Why this should not be posted…'),
        { target: { value: 'wrong supplier' } },
      );
      fireEvent.click(
        screen.getByRole('button', { name: 'Reject & return to draft' }),
      );
      await waitFor(() => expect(stored().entries[0]?.tone).toBe('ok'));
      expect(stored().entries).toHaveLength(1);
      expect(stored().entries[0]).toMatchObject({
        action: 'Reject',
        title: 'Expense #214',
      });
      expect(stored().entries[0].outcome).toMatch(
        /Rejected — returned to draft — nothing was posted\. Reason: wrong supplier/,
      );
    });

    it('a successful approve records the object and its outcome', async () => {
      vi.mocked(api.approveApproval).mockResolvedValue({} as never);
      renderAt('/inbox/approval/7');
      fireEvent.click(
        await screen.findByRole('button', { name: 'Approve · −89.00 €' }),
      );
      await waitFor(() => expect(stored().entries).toHaveLength(1));
      expect(stored().entries[0]).toMatchObject({
        action: 'Approve',
        title: 'Expense #214',
        outcome: 'Approved & posted · −89.00 €',
        tone: 'ok',
      });
    });
  });
});
