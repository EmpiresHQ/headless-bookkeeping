import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { IntakeView } from './IntakeView';
import * as api from '../api';

const doc: api.DocumentRow = {
  id: 5,
  filename: 'invoice.pdf',
  mime_type: 'application/pdf',
  size_bytes: 2048,
  status: 'pending',
  processing_since: null,
  created_at: 0,
};

const triageItem: api.NeedsTriageItem = {
  id: 7,
  filename: 'low-confidence.pdf',
  created_at: 0,
  reason: 'AI confidence 0.61 below threshold 0.8',
  reason_type: 'low_confidence',
};

describe('IntakeView', () => {
  beforeEach(() => {
    vi.spyOn(api, 'getTriagePending').mockResolvedValue([doc]);
    vi.spyOn(api, 'getNeedsTriageItems').mockResolvedValue([]);
    vi.spyOn(api, 'uploadDocument').mockResolvedValue({
      document: doc,
      deduplicated: false,
    });
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

  it('auto-triages after upload and shows the outcome in the note', async () => {
    render(<IntakeView />);
    const input = screen.getByLabelText(/upload document/i);
    const file = new File(['pdf'], 'invoice.pdf', { type: 'application/pdf' });
    Object.defineProperty(input, 'files', {
      value: [file],
      configurable: true,
    });
    fireEvent.change(input);
    fireEvent.click(screen.getByRole('button', { name: /upload/i }));

    await waitFor(() => {
      expect(api.uploadDocument).toHaveBeenCalled();
      expect(api.triageDocument).toHaveBeenCalledWith(5);
    });
  });

  it('retries triage for an already-pending document', async () => {
    render(<IntakeView />);
    expect(await screen.findByText('invoice.pdf')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /retry/i }));

    await waitFor(() => expect(api.triageDocument).toHaveBeenCalledWith(5));
    expect(await screen.findByText(/expense #42/i)).toBeInTheDocument();
  });

  it('shows needs-triage items with reason badge', async () => {
    vi.spyOn(api, 'getNeedsTriageItems').mockResolvedValue([triageItem]);
    vi.spyOn(api, 'getTriagePending').mockResolvedValue([]);

    render(<IntakeView />);
    expect(await screen.findByText('low-confidence.pdf')).toBeInTheDocument();
    expect(screen.getByText(/low ai confidence/i)).toBeInTheDocument();
  });

  it('shows a Needs triage section with parked documents and dismisses them', async () => {
    const parkedItem: api.NeedsTriageItem = {
      id: 6,
      filename: 'creditnote.pdf',
      created_at: 0,
      reason: 'AI confidence below threshold',
      reason_type: 'low_confidence',
    };
    vi.spyOn(api, 'getNeedsTriageItems').mockResolvedValue([parkedItem]);
    vi.spyOn(api, 'getTriagePending').mockResolvedValue([]);

    render(<IntakeView />);
    expect(await screen.findByText('creditnote.pdf')).toBeInTheDocument();

    // Dismiss the parked document → completeDocument is called.
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    await waitFor(() => expect(api.completeDocument).toHaveBeenCalledWith(6));
  });

  it('expands row on click and shows manual form for low_confidence', async () => {
    vi.spyOn(api, 'getNeedsTriageItems').mockResolvedValue([triageItem]);
    vi.spyOn(api, 'getDocumentDebug').mockResolvedValue({
      document_id: 7,
      ocr: { ok: false, category: 'unreadable', detail: 'blur' },
      classification: null,
    });
    vi.spyOn(api, 'getCategories').mockResolvedValue([]);
    vi.spyOn(api, 'getEntities').mockResolvedValue([]);
    vi.spyOn(api, 'getTriagePending').mockResolvedValue([]);

    render(<IntakeView />);
    const filename = await screen.findByText('low-confidence.pdf');
    fireEvent.click(filename);
    expect(
      await screen.findByText(/manual classification/i),
    ).toBeInTheDocument();
  });

  it('resolves a needs_triage document via the create-supplier path', async () => {
    const supplierItem: api.NeedsTriageItem = {
      id: 4,
      filename: 'inv.pdf',
      created_at: 0,
      reason: 'supplier creation not yet implemented (Task 43)',
      reason_type: 'supplier_unresolved',
    };
    vi.spyOn(api, 'getTriagePending').mockResolvedValue([]);
    vi.spyOn(api, 'getNeedsTriageItems').mockResolvedValue([supplierItem]);
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

    // Click on the row to expand it (which shows ResolveSupplierForm)
    fireEvent.click(screen.getByText('inv.pdf'));
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

  it('shows Processing… for a document with processing_since set', async () => {
    const processing = { ...doc, id: 7, processing_since: 1718000000 };
    vi.spyOn(api, 'getTriagePending').mockResolvedValue([doc, processing]);
    vi.spyOn(api, 'getNeedsTriageItems').mockResolvedValue([]);

    render(<IntakeView />);

    expect(await screen.findByText('Processing…')).toBeInTheDocument();
  });

  it('renders a Sales invoice outcome after triage', async () => {
    vi.spyOn(api, 'triageDocument').mockResolvedValue({
      kind: 'invoice',
      document_id: 5,
      invoice_id: 55,
    });

    render(<IntakeView />);
    expect(await screen.findByText('invoice.pdf')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /retry/i }));

    expect(await screen.findByText(/Sales invoice #55/i)).toBeInTheDocument();
  });

  it('renders a bank_statement outcome after triage', async () => {
    vi.spyOn(api, 'triageDocument').mockResolvedValue({
      kind: 'bank_statement',
      document_id: 5,
      job_id: 99,
    });

    render(<IntakeView />);
    expect(await screen.findByText('invoice.pdf')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /retry/i }));

    expect(
      await screen.findByText(/Bank import started.*job #99/i),
    ).toBeInTheDocument();
  });

  it('shows manual classify-as-invoice form for an outgoing-invoice needs-triage item', async () => {
    const outgoingItem: api.NeedsTriageItem = {
      id: 9,
      filename: 'outgoing.pdf',
      created_at: 0,
      reason: 'Outgoing invoice — no invoice number found on the document',
      reason_type: 'outgoing_invoice',
    };
    vi.spyOn(api, 'getNeedsTriageItems').mockResolvedValue([outgoingItem]);
    vi.spyOn(api, 'getTriagePending').mockResolvedValue([]);
    vi.spyOn(api, 'getEntities').mockResolvedValue([]);

    render(<IntakeView />);
    await screen.findByText('outgoing.pdf');

    fireEvent.click(screen.getByText('outgoing.pdf'));

    expect(
      await screen.findByText(/classify as sales invoice/i),
    ).toBeInTheDocument();
  });

  it('posts target:sales_invoice when operator classifies a parked document as invoice', async () => {
    const outgoingItem: api.NeedsTriageItem = {
      id: 9,
      filename: 'outgoing.pdf',
      created_at: 0,
      reason: 'Outgoing invoice — no invoice number found on the document',
      reason_type: 'outgoing_invoice',
    };
    vi.spyOn(api, 'getNeedsTriageItems').mockResolvedValue([outgoingItem]);
    vi.spyOn(api, 'getTriagePending').mockResolvedValue([]);
    vi.spyOn(api, 'getEntities').mockResolvedValue([]);
    const classifySpy = vi
      .spyOn(api, 'manualClassifyInvoice')
      .mockResolvedValue({ kind: 'invoice', document_id: 9, invoice_id: 77 });

    render(<IntakeView />);
    await screen.findByText('outgoing.pdf');

    // Expand the row
    fireEvent.click(screen.getByText('outgoing.pdf'));
    await screen.findByText(/classify as sales invoice/i);

    // Fill in required fields
    fireEvent.change(screen.getByLabelText(/invoice number/i), {
      target: { value: 'INV-001' },
    });
    fireEvent.change(screen.getByLabelText(/gross amount/i), {
      target: { value: '121.00' },
    });
    fireEvent.change(screen.getByLabelText(/vat amount/i), {
      target: { value: '21.00' },
    });
    fireEvent.change(screen.getByLabelText(/date/i), {
      target: { value: '2026-06-01' },
    });

    fireEvent.click(
      screen.getByRole('button', { name: /save.*sales invoice/i }),
    );

    await waitFor(() => {
      expect(classifySpy).toHaveBeenCalledWith(
        9,
        expect.objectContaining({
          target: 'sales_invoice',
          invoice_number: 'INV-001',
          gross_amount: 12100,
          vat_amount: 2100,
          tax_point_date: '2026-06-01',
        }),
      );
    });
  });
});
