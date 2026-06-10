import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ExpensesView } from './ExpensesView';
import * as api from '../api';

vi.mock('../api', () => ({
  getExpenses: vi.fn(),
  createExpense: vi.fn(),
  deleteExpense: vi.fn(),
  correctExpense: vi.fn(),
  fmtCents: (c: number) => (c / 100).toFixed(2),
}));

const posted = {
  id: 9,
  supplier_id: null,
  category: 'transport',
  gross_amount: 1525,
  vat_amount: 285,
  currency: 'EUR',
  tax_point_date: '2026-05-01',
  status: 'posted',
  reconciled: false,
};

describe('ExpensesView', () => {
  beforeEach(() => {
    vi.mocked(api.getExpenses).mockResolvedValue([{ ...posted }]);
    vi.mocked(api.createExpense).mockResolvedValue({ ...posted, id: 10 });
    vi.mocked(api.correctExpense).mockResolvedValue({ outcome: 'corrected' });
  });
  afterEach(() => vi.restoreAllMocks());

  it('creates an expense, converting euros to integer cents', async () => {
    render(<ExpensesView />);
    await screen.findByText('transport');

    fireEvent.change(screen.getByLabelText('Category'), {
      target: { value: 'software' },
    });
    fireEvent.change(screen.getByLabelText('Gross'), {
      target: { value: '15.25' },
    });
    fireEvent.change(screen.getByLabelText('VAT'), {
      target: { value: '2.85' },
    });
    fireEvent.change(screen.getByLabelText('Tax point date'), {
      target: { value: '2026-05-02' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^add$/i }));

    expect(api.createExpense).toHaveBeenCalledWith({
      category: 'software',
      gross_amount: 1525,
      vat_amount: 285,
      currency: 'EUR',
      tax_point_date: '2026-05-02',
    });
  });

  it('corrects a posted expense', async () => {
    render(<ExpensesView />);
    await screen.findByText('transport');

    fireEvent.click(screen.getByRole('button', { name: /correct/i }));
    fireEvent.change(screen.getByLabelText('Correction reason'), {
      target: { value: 'wrong amount' },
    });
    fireEvent.change(screen.getByLabelText('Correction gross'), {
      target: { value: '20.00' },
    });
    fireEvent.click(screen.getByRole('button', { name: /post correction/i }));

    expect(api.correctExpense).toHaveBeenCalledWith(9, {
      kind: 'financial',
      reason: 'wrong amount',
      patch: { gross_amount: 2000, vat_amount: 285, category: 'transport' },
    });
  });
});
