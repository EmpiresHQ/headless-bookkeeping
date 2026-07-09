import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { AppToaster } from '../ui/toast';
import { ExpenseScreen } from './ExpenseScreen';

vi.mock('../api', async (io) => ({
  ...(await io<typeof import('../api')>()),
  getExpense: vi.fn(),
  getExpenses: vi.fn(),
  getEntities: vi.fn(),
  getDocuments: vi.fn(),
  listApprovals: vi.fn(),
  postExpense: vi.fn(),
  deleteExpense: vi.fn(),
  // CorrectSheet (mounted for posted expenses from Task 6 on) reads these:
  getCategories: vi.fn(),
}));
import {
  deleteExpense,
  getCategories,
  getDocuments,
  getEntities,
  getExpense,
  getExpenses,
  listApprovals,
  postExpense,
} from '../api';

const DETAIL = {
  id: 12,
  document_id: 9,
  supplier_id: 3,
  category: 'rent',
  gross_amount: 65000,
  vat_amount: 11721,
  currency: 'EUR',
  tax_point_date: '2026-06-25',
  status: 'posted',
  supplier_invoice_number: 'A-183',
  ai_confidence: 0.96,
  claimant_id: null,
  created_at: 1750830000,
};

function mountAt(
  detail: Partial<typeof DETAIL> = {},
  listStatus = 'posted',
  rejections: unknown[] = [],
) {
  vi.mocked(getExpense).mockResolvedValue({ ...DETAIL, ...detail } as never);
  vi.mocked(getExpenses).mockResolvedValue([
    {
      id: 12,
      supplier_id: 3,
      category: 'rent',
      gross_amount: 65000,
      vat_amount: 11721,
      currency: 'EUR',
      tax_point_date: '2026-06-25',
      status: listStatus,
      reconciled: true,
    },
  ] as never);
  vi.mocked(getEntities).mockResolvedValue([
    {
      id: 3,
      role: 'supplier',
      country: 'EE',
      name: 'AS Merko Ehitus',
      goods_vs_services: null,
    },
  ] as never);
  vi.mocked(getDocuments).mockResolvedValue([
    { id: 9, expense_id: 12, filename: 'arve-183.pdf' },
  ] as never);
  // MUST be mocked BEFORE render — the rejection query fires on mount.
  vi.mocked(listApprovals).mockResolvedValue(rejections as never);
  vi.mocked(getCategories).mockResolvedValue([] as never);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/books/expenses/12']}>
        <AppToaster />
        <Routes>
          <Route path="/books/expenses/:id" element={<ExpenseScreen />} />
          <Route path="/books" element={<div>BOOKS LIST</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('ExpenseScreen', () => {
  it('renders hero, facts with implied VAT rate, navigable document row and bank STATUS (no link)', async () => {
    mountAt();
    expect(
      await screen.findByText('AS Merko Ehitus · rent'),
    ).toBeInTheDocument();
    expect(screen.getByText('-650.00 €')).toBeInTheDocument();
    expect(screen.getByText('117.21 € (22%)')).toBeInTheDocument();
    expect(screen.getByText('25.06.2026')).toBeInTheDocument();
    expect(screen.getByText('A-183')).toBeInTheDocument();
    // Document row is a REAL route (fixes the #expense-N dead-end class):
    expect(screen.getByRole('link', { name: /arve-183\.pdf/ })).toHaveAttribute(
      'href',
      '/books/documents/9',
    );
    // Bank is a status, not a navigation (no endpoint maps expense→tx):
    expect(screen.getByText('🏦 Reconciled')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Reconciled/ })).toBeNull();
    // Posted state: read-only ADR-0009 hint, no Delete.
    expect(screen.getByText(/only through a correction/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Delete/ })).toBeNull();
  });

  it('drafts show the rejection reason and Submit for posting with a humanized HELD receipt', async () => {
    vi.mocked(postExpense).mockResolvedValue({
      expense: { id: 12, status: 'pending' },
      policy: {
        action: 'hold-for-approval',
        reason: 'Voucher amount 65000 exceeds ceiling 5000',
      },
    } as never);
    mountAt({ status: 'draft' }, 'draft', [
      {
        id: 4,
        object_type: 'expense',
        object_id: 12,
        status: 'rejected',
        requested_by: 'system',
        approved_by: null,
        rejected_reason: 'Wrong supplier picked',
        policy_reason: null,
        superseded_by: null,
        created_at: 1750000000,
        resolved_at: 1750900000,
      },
    ]);
    expect(
      await screen.findByText(/Wrong supplier picked/),
    ).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole('button', { name: 'Submit for posting' }),
    );
    await waitFor(() => expect(postExpense).toHaveBeenCalledWith(12));
    expect(
      await screen.findByText(
        /Held for approval — 650\.00 € above the 50\.00 € auto-post limit/,
      ),
    ).toBeInTheDocument();
  });

  it('Delete draft goes plan→confirm→receipt and navigates back to the list', async () => {
    vi.mocked(deleteExpense).mockResolvedValue({ id: 12 } as never);
    mountAt({ status: 'draft' }, 'draft');
    await userEvent.click(
      await screen.findByRole('button', { name: 'Delete draft…' }),
    );
    // Nothing deleted yet — ConfirmDialog first:
    expect(deleteExpense).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(deleteExpense).toHaveBeenCalledWith(12));
    expect(await screen.findByText('BOOKS LIST')).toBeInTheDocument();
  });

  it('a corrected (reversed) expense explains one-shot corrections and shows the corrected marker', async () => {
    mountAt({ status: 'reversed' }, 'reversed');
    expect(await screen.findByText('corrected')).toBeInTheDocument();
    expect(
      screen.getByText(/Already corrected — corrections are one-shot/),
    ).toBeInTheDocument();
  });

  it('detail fetch failure renders a retryable LoadError, not skeletons forever', async () => {
    vi.mocked(getExpense).mockRejectedValue(new Error('nope'));
    vi.mocked(getExpenses).mockResolvedValue([] as never);
    vi.mocked(getEntities).mockResolvedValue([] as never);
    vi.mocked(getDocuments).mockResolvedValue([] as never);
    vi.mocked(listApprovals).mockResolvedValue([] as never);
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/books/expenses/12']}>
          <Routes>
            <Route path="/books/expenses/:id" element={<ExpenseScreen />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByText('nope')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
