import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import * as api from '../api';
import { CreditNotesView } from './CreditNotesView';

vi.mock('../api', () => ({
  listCreditNotes: vi.fn(),
  createCreditNote: vi.fn(),
}));

describe('CreditNotesView', () => {
  beforeEach(() => {
    vi.mocked(api.listCreditNotes).mockResolvedValue([]);
    vi.mocked(api.createCreditNote).mockResolvedValue({
      id: 1,
      credit_note_number: 'CN-1',
      status: 'posted',
      gross_amount: 5000,
      vat_amount: 1000,
      currency: 'EUR',
      tax_point_date: '2026-05-01',
      created_at: 1751000000,
      credits_object_type: 'sales_invoice',
      credits_object_id: 1,
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it('submits a credit note and shows it in the list', async () => {
    render(<CreditNotesView />);

    fireEvent.change(screen.getByLabelText(/credit note number/i), {
      target: { value: 'CN-1' },
    });
    fireEvent.change(screen.getByLabelText(/object type/i), {
      target: { value: 'sales_invoice' },
    });
    fireEvent.change(screen.getByLabelText(/object id/i), {
      target: { value: '1' },
    });
    fireEvent.change(screen.getByLabelText(/gross amount/i), {
      target: { value: '5000' },
    });
    fireEvent.change(screen.getByLabelText(/vat amount/i), {
      target: { value: '1000' },
    });
    fireEvent.change(screen.getByLabelText(/tax point date/i), {
      target: { value: '2026-01-31' },
    });

    fireEvent.click(screen.getByRole('button', { name: /issue credit note/i }));

    expect(await screen.findByText('CN-1')).toBeInTheDocument();
  });
});
