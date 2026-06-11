import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { IntakeView } from './IntakeView';
import * as api from '../api';

const doc = {
  id: 5,
  filename: 'invoice.pdf',
  mime_type: 'application/pdf',
  size_bytes: 2048,
  status: 'pending',
  created_at: 0,
};

describe('IntakeView', () => {
  beforeEach(() => {
    vi.spyOn(api, 'getTriagePending').mockResolvedValue([doc]);
    vi.spyOn(api, 'getDocuments').mockResolvedValue([doc]);
    vi.spyOn(api, 'triageDocument').mockResolvedValue({
      kind: 'expense',
      document_id: 5,
      expense_id: 42,
    });
    vi.spyOn(api, 'completeDocument').mockResolvedValue({
      id: 6,
      status: 'processed',
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it('lists pending documents and runs triage, showing the outcome', async () => {
    render(<IntakeView />);
    expect(await screen.findByText('invoice.pdf')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /run triage/i }));

    await waitFor(() => expect(api.triageDocument).toHaveBeenCalledWith(5));
    expect(await screen.findByText(/expense #42/i)).toBeInTheDocument();
  });

  it('shows a Needs triage section with parked documents and dismisses them', async () => {
    const parked = {
      ...doc,
      id: 6,
      filename: 'creditnote.pdf',
      status: 'needs_triage',
    };
    vi.spyOn(api, 'getDocuments').mockResolvedValue([doc, parked]);

    render(<IntakeView />);
    expect(await screen.findByText('creditnote.pdf')).toBeInTheDocument();

    // Dismiss the parked document → completeDocument is called.
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    await waitFor(() => expect(api.completeDocument).toHaveBeenCalledWith(6));
  });

  it('resolves a needs_triage document via the create-supplier path', async () => {
    vi.spyOn(api, 'getTriagePending').mockResolvedValue([]);
    vi.spyOn(api, 'getDocuments').mockResolvedValue([
      {
        id: 4,
        filename: 'inv.pdf',
        mime_type: 'application/pdf',
        size_bytes: 1,
        status: 'needs_triage',
        created_at: 0,
      },
    ]);
    vi.spyOn(api, 'getPendingDraft').mockResolvedValue({
      document_id: 4,
      reason: 'supplier creation not yet implemented (Task 43)',
      supplier_proposal: {
        create_name: 'Acme OÜ',
        create_country: 'EE',
        create_registration_key: 'EE100200300',
      },
      draft: {
        category: 'software',
        gross_amount: 1525,
        vat_amount: 285,
        currency: 'EUR',
        tax_point_date: '2026-03-15',
        supplier_invoice_number: 'INV-7',
      },
    });
    vi.spyOn(api, 'getEntities').mockResolvedValue([]);
    vi.spyOn(api, 'onboardEntity').mockResolvedValue({
      id: 3,
      role: 'supplier',
      country: 'EE',
      name: 'Acme OÜ',
      goods_vs_services: null,
    });
    vi.spyOn(api, 'resolveSupplier').mockResolvedValue({
      kind: 'expense',
      document_id: 4,
      expense_id: 55,
    });

    render(<IntakeView />);
    await screen.findByText('inv.pdf');

    fireEvent.click(screen.getByRole('button', { name: 'Resolve' }));
    await screen.findByText('Acme OÜ', { exact: false });

    fireEvent.change(screen.getByLabelText('Registration key'), {
      target: { value: 'EE123' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Create supplier & book' }),
    );

    await waitFor(() => {
      expect(api.onboardEntity).toHaveBeenCalledWith(
        expect.objectContaining({
          role: 'supplier',
          name: 'Acme OÜ',
          country: 'EE',
          registrationKey: 'EE123',
        }),
      );
      expect(api.resolveSupplier).toHaveBeenCalledWith(4, 3);
    });
  });
});
