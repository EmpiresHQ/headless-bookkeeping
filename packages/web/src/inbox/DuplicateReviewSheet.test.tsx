import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, expect, it, vi } from 'vitest';
import {
  duplicateExpenseId,
  DuplicateReviewSheet,
} from './DuplicateReviewSheet';
import { getDocumentDetails, getExpense } from '../api';

vi.mock('../api', async (original) => ({
  ...(await original<typeof import('../api')>()),
  getDocumentDetails: vi.fn(),
  getExpense: vi.fn(),
}));
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getDocumentDetails).mockResolvedValue({
    document_id: 195,
    ocr: { ok: true, markdown: '' },
    classification: null,
  });
});
function mount(reason: string, open = true) {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter>
        <DuplicateReviewSheet
          documentId={195}
          reason={reason}
          open={open}
          onOpenChange={vi.fn()}
          onArchive={vi.fn()}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
it.each([
  null,
  '',
  'expense #113',
  'possible duplicate of expense #0:',
  'possible duplicate of expense #-1:',
  'possible duplicate of expense #1.2:',
  'possible duplicate of expense #9007199254740992:',
])('rejects invalid reference %s', (reason) => {
  expect(duplicateExpenseId(reason)).toBeNull();
});
it('accepts the persisted duplicate reason', () => {
  expect(
    duplicateExpenseId(
      'possible duplicate of expense #113: same supplier and invoice number 2AUEKTA3 0002.',
    ),
  ).toBe(113);
});
it('does not fetch while closed', () => {
  mount('possible duplicate of expense #113:', false);
  expect(getExpense).not.toHaveBeenCalled();
  expect(getDocumentDetails).not.toHaveBeenCalled();
});
it('does not guess a target or offer archive when the reference is unavailable', async () => {
  mount('invoice 113 may be a duplicate');
  expect(await screen.findByRole('status')).toHaveTextContent(
    'reference is unavailable',
  );
  expect(getExpense).not.toHaveBeenCalled();
  expect(
    screen.queryByRole('button', { name: 'Archive this duplicate' }),
  ).not.toBeInTheDocument();
});
it('handles an unavailable expense without opening classification', async () => {
  vi.mocked(getExpense).mockRejectedValue(new Error('404'));
  mount('possible duplicate of expense #113:');
  expect(
    await screen.findByText(/Could not load the existing expense/),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole('link', { name: 'Open existing expense' }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole('button', {
      name: /Create expense|Archive this duplicate/,
    }),
  ).not.toBeInTheDocument();
});

it('accepts the server receipt-for-expense prefix', () => {
  expect(
    duplicateExpenseId(
      'receipt for expense #113: possible duplicate of expense #113: same supplier',
    ),
  ).toBe(113);
});
it('shows the actual draft status and missing extracted facts without claiming it is booked', async () => {
  vi.mocked(getExpense).mockResolvedValue({
    id: 113,
    document_id: null,
    supplier_id: null,
    category: 'software',
    gross_amount: 400,
    vat_amount: 0,
    currency: 'EUR',
    tax_point_date: '2026-09-10',
    status: 'draft',
    supplier_invoice_number: null,
    ai_confidence: null,
    claimant_id: null,
    created_at: 100,
  });
  mount('possible duplicate of expense #113:');
  expect(await screen.findByText('Expense #113 · draft')).toBeInTheDocument();
  expect(screen.getAllByText('Not extracted').length).toBeGreaterThan(0);
  expect(
    screen.queryByRole('link', { name: 'Open existing document' }),
  ).not.toBeInTheDocument();
});
