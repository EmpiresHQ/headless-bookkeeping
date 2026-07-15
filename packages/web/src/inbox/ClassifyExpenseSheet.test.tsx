import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  getDocumentDetails: vi.fn(),
  // Kept mocked as a canary: no test may ever call this from the sheet.
  getDocumentReclassify: vi.fn(),
  getCategories: vi.fn(),
  getEntities: vi.fn(),
  getExpenses: vi.fn(),
  manualClassify: vi.fn(),
  onboardEntity: vi.fn(),
}));

import * as api from '../api';
import { ClassifyExpenseSheet } from './ClassifyExpenseSheet';

function renderSheet(onDone = vi.fn()) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <ClassifyExpenseSheet
        documentId={12}
        open
        onOpenChange={() => undefined}
        onDone={onDone}
      />
    </QueryClientProvider>,
  );
  return onDone;
}

describe('ClassifyExpenseSheet', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getDocumentDetails).mockResolvedValue({
      document_id: 12,
      ocr: { ok: true, markdown: 'CIRCLE K …' },
      classification: {
        ok: true,
        result: {
          kind: 'new_expense',
          document_type: 'receipt',
          gross_amount: 4820,
          vat_amount: 867,
          currency: 'EUR',
          tax_point_date: '2026-07-01',
          category: 'fuel',
          document_vat_marking: null,
          supplier_invoice_number: null,
          confidence: 0.41,
        },
      },
    });
    vi.mocked(api.getCategories).mockResolvedValue([
      { key: 'fuel', label: 'Fuel', accountCode: '5000' },
      { key: 'meals', label: 'Meals', accountCode: '5100' },
      { key: 'office', label: 'Office', accountCode: '5200' },
      { key: 'transport', label: 'Transport', accountCode: '5300' },
      { key: 'software', label: 'Software & IT', accountCode: '5400' },
    ]);
    vi.mocked(api.getEntities).mockResolvedValue([
      {
        id: 3,
        role: 'supplier',
        country: 'EE',
        name: 'Circle K Eesti AS',
        goods_vs_services: null,
      },
    ]);
    vi.mocked(api.getExpenses).mockResolvedValue([
      {
        id: 1,
        supplier_id: 3,
        category: 'fuel',
        gross_amount: 1,
        vat_amount: 0,
        currency: 'EUR',
        tax_point_date: '2026-06-01',
        supplier_invoice_number: null,
        status: 'posted',
        reconciled: false,
      },
      {
        id: 2,
        supplier_id: 3,
        category: 'fuel',
        gross_amount: 1,
        vat_amount: 0,
        currency: 'EUR',
        tax_point_date: '2026-06-15',
        supplier_invoice_number: null,
        status: 'posted',
        reconciled: false,
      },
      {
        id: 3,
        supplier_id: 3,
        category: 'office',
        gross_amount: 1,
        vat_amount: 0,
        currency: 'EUR',
        tax_point_date: '2026-05-01',
        supplier_invoice_number: null,
        status: 'posted',
        reconciled: false,
      },
    ]);
    vi.mocked(api.manualClassify).mockResolvedValue({
      kind: 'expense',
      document_id: 12,
      expense_id: 700,
    });
  });

  it('prefills amounts, date and category from the persisted facts and states the outcome on the button', async () => {
    renderSheet();
    expect(await screen.findByDisplayValue('48.20')).toBeInTheDocument();
    expect(screen.getByDisplayValue('8.67')).toBeInTheDocument();
    expect(screen.getByDisplayValue('2026-07-01')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Create expense · −48.20 €' }),
    ).toBeInTheDocument();
    // Predicted category chip is selected.
    expect(screen.getByRole('button', { name: 'Fuel' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    // NEVER re-runs OCR/LLM — prefill comes from the persisted details only.
    expect(api.getDocumentReclassify).not.toHaveBeenCalled();
    expect(
      screen.queryByText(/re-reading the document/i),
    ).not.toBeInTheDocument();
  });

  it('prefills a classification_failed document from persisted facts (no re-OCR)', async () => {
    vi.mocked(api.getDocumentDetails).mockResolvedValue({
      document_id: 12,
      ocr: { ok: true, markdown: 'CITYBEE …' },
      classification: {
        ok: true,
        result: {
          kind: 'new_expense',
          document_type: 'receipt',
          gross_amount: 16300,
          vat_amount: 3900,
          currency: 'EUR',
          tax_point_date: '2026-07-08',
          category: 'vehicle',
          document_vat_marking: null,
          supplier_invoice_number: 'EECTB1805772',
          confidence: 1.0,
        },
      },
    });
    vi.mocked(api.getCategories).mockResolvedValue([
      { key: 'vehicle', label: 'Vehicle', accountCode: '5500' },
      { key: 'fuel', label: 'Fuel', accountCode: '5000' },
      { key: 'meals', label: 'Meals', accountCode: '5100' },
      { key: 'office', label: 'Office', accountCode: '5200' },
    ]);
    renderSheet();
    expect(await screen.findByDisplayValue('163.00')).toBeInTheDocument();
    expect(screen.getByDisplayValue('39.00')).toBeInTheDocument();
    expect(screen.getByDisplayValue('2026-07-08')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Vehicle' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(api.getDocumentReclassify).not.toHaveBeenCalled();
  });

  it('falls back to an empty manual form when the persisted classification is null (no auto re-OCR)', async () => {
    vi.mocked(api.getDocumentDetails).mockResolvedValue({
      document_id: 12,
      ocr: { ok: true, markdown: 'x' },
      classification: null,
    });
    const onDone = renderSheet();
    expect(await screen.findByText(/no saved ai facts/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/amount \(eur\)/i)).toHaveValue('');
    expect(screen.getByLabelText('VAT')).toHaveValue('');
    expect(api.getDocumentReclassify).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText(/amount \(eur\)/i), {
      target: { value: '25.00' },
    });
    fireEvent.change(screen.getByLabelText('VAT'), {
      target: { value: '4.51' },
    });
    fireEvent.change(screen.getByLabelText(/date/i), {
      target: { value: '2026-07-10' },
    });
    fireEvent.change(screen.getByPlaceholderText(/search suppliers/i), {
      target: { value: 'circle' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Circle K Eesti AS/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Fuel' }));

    const submit = screen.getByRole('button', { name: /Create expense/ });
    await waitFor(() => expect(submit).toBeEnabled());
    fireEvent.click(submit);
    await waitFor(() =>
      expect(api.manualClassify).toHaveBeenCalledWith(12, {
        supplier_id: 3,
        category: 'fuel',
        document_vat_marking: null,
        gross_amount: 2500,
        vat_amount: 451,
        currency: 'EUR',
        tax_point_date: '2026-07-10',
        supplier_invoice_number: null,
      }),
    );
    expect(onDone).toHaveBeenCalled();
  });

  it('creates a new supplier inline and submits with its id', async () => {
    vi.mocked(api.getEntities).mockResolvedValue([]); // no match for "citybee"
    vi.mocked(api.onboardEntity).mockResolvedValue({
      id: 9,
      role: 'supplier',
      country: 'EE',
      name: 'Citybee Eesti OÜ',
      goods_vs_services: null,
    });
    renderSheet();
    await screen.findByDisplayValue('48.20');

    fireEvent.change(screen.getByPlaceholderText(/search suppliers/i), {
      target: { value: 'citybee' },
    });
    expect(
      await screen.findByText(/create it with.*new supplier/i),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'New supplier…' }));

    expect(screen.getByLabelText('Name')).toHaveValue('citybee'); // seeded
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'Citybee Eesti OÜ' },
    });
    fireEvent.change(screen.getByLabelText('Country'), {
      target: { value: 'EE' },
    });
    fireEvent.change(screen.getByLabelText('Reg. key'), {
      target: { value: 'EE102139798' },
    });

    const add = screen.getByRole('button', { name: 'Add supplier' });
    await waitFor(() => expect(add).toBeEnabled());
    fireEvent.click(add);

    await waitFor(() =>
      expect(api.onboardEntity).toHaveBeenCalledWith({
        role: 'supplier',
        name: 'Citybee Eesti OÜ',
        country: 'EE',
        registrationKey: 'EE102139798',
      }),
    );
    expect(await screen.findByText('Citybee Eesti OÜ')).toBeInTheDocument();
    // Creating the supplier must NOT book — booking happens only via the
    // main "Create expense" submit below.
    expect(api.manualClassify).not.toHaveBeenCalled();

    const submit = screen.getByRole('button', {
      name: 'Create expense · −48.20 €',
    });
    fireEvent.click(submit);
    await waitFor(() =>
      expect(api.manualClassify).toHaveBeenCalledWith(
        12,
        expect.objectContaining({ supplier_id: 9 }),
      ),
    );
  });

  it('prefills the new-supplier form from extracted_supplier (create proposal)', async () => {
    vi.mocked(api.getEntities).mockResolvedValue([]); // no match — forces create
    vi.mocked(api.getDocumentDetails).mockResolvedValue({
      document_id: 12,
      ocr: { ok: true, markdown: 'CITYBEE …' },
      classification: {
        ok: true,
        result: {
          kind: 'new_expense',
          document_type: 'receipt',
          gross_amount: 4820,
          vat_amount: 867,
          currency: 'EUR',
          tax_point_date: '2026-07-01',
          category: 'fuel',
          document_vat_marking: null,
          supplier_invoice_number: null,
          confidence: 0.41,
        },
        extracted_supplier: {
          name: 'Citybee Eesti OÜ',
          country: 'EE',
          registration_key: 'EE102139798',
        },
      },
    });
    vi.mocked(api.onboardEntity).mockResolvedValue({
      id: 9,
      role: 'supplier',
      country: 'EE',
      name: 'Citybee Eesti OÜ',
      goods_vs_services: null,
    });
    renderSheet();
    await screen.findByDisplayValue('48.20');

    fireEvent.click(screen.getByRole('button', { name: 'New supplier…' }));

    expect(screen.getByLabelText('Name')).toHaveValue('Citybee Eesti OÜ');
    expect(screen.getByLabelText('Country')).toHaveValue('EE');
    expect(screen.getByLabelText('Reg. key')).toHaveValue('EE102139798');

    const add = screen.getByRole('button', { name: 'Add supplier' });
    expect(add).toBeEnabled();
    fireEvent.click(add);

    await waitFor(() =>
      expect(api.onboardEntity).toHaveBeenCalledWith({
        role: 'supplier',
        name: 'Citybee Eesti OÜ',
        country: 'EE',
        registrationKey: 'EE102139798',
      }),
    );
    // Creating the supplier must NOT book.
    expect(api.manualClassify).not.toHaveBeenCalled();
  });

  it('falls back to the search text for Name when extracted_supplier has no name (match proposal)', async () => {
    vi.mocked(api.getEntities).mockResolvedValue([]); // no match for "citybee"
    vi.mocked(api.getDocumentDetails).mockResolvedValue({
      document_id: 12,
      ocr: { ok: true, markdown: 'CITYBEE …' },
      classification: {
        ok: true,
        result: {
          kind: 'new_expense',
          document_type: 'receipt',
          gross_amount: 4820,
          vat_amount: 867,
          currency: 'EUR',
          tax_point_date: '2026-07-01',
          category: 'fuel',
          document_vat_marking: null,
          supplier_invoice_number: null,
          confidence: 0.41,
        },
        extracted_supplier: {
          name: null,
          country: 'EE',
          registration_key: 'EE123',
        },
      },
    });
    renderSheet();
    await screen.findByDisplayValue('48.20');

    fireEvent.change(screen.getByPlaceholderText(/search suppliers/i), {
      target: { value: 'citybee' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'New supplier…' }));

    expect(screen.getByLabelText('Name')).toHaveValue('citybee'); // search fallback
    expect(screen.getByLabelText('Country')).toHaveValue('EE');
    expect(screen.getByLabelText('Reg. key')).toHaveValue('EE123');
  });

  it('never clobbers a field the operator already typed once the AI extraction lands', async () => {
    vi.mocked(api.getEntities).mockResolvedValue([]);
    let resolveDetails!: (
      v: Awaited<ReturnType<typeof api.getDocumentDetails>>,
    ) => void;
    vi.mocked(api.getDocumentDetails).mockReturnValue(
      new Promise((resolve) => {
        resolveDetails = resolve;
      }),
    );
    renderSheet();

    // Open the create form and type a Country BEFORE the details land.
    fireEvent.click(
      await screen.findByRole('button', { name: 'New supplier…' }),
    );
    fireEvent.change(screen.getByLabelText('Country'), {
      target: { value: 'DK' },
    });

    resolveDetails({
      document_id: 12,
      ocr: { ok: true, markdown: 'X …' },
      classification: {
        ok: true,
        result: {
          kind: 'new_expense',
          document_type: 'receipt',
          gross_amount: 4820,
          vat_amount: 867,
          currency: 'EUR',
          tax_point_date: '2026-07-01',
          category: 'fuel',
          document_vat_marking: null,
          supplier_invoice_number: null,
          confidence: 0.41,
        },
        extracted_supplier: {
          name: 'X',
          country: 'EE',
          registration_key: 'EE999',
        },
      },
    });

    // Name was untouched — fills from the extraction.
    await waitFor(() => expect(screen.getByLabelText('Name')).toHaveValue('X'));
    // Country was already typed — stays untouched by the later extraction.
    expect(screen.getByLabelText('Country')).toHaveValue('DK');
  });

  it('requires the registration key to add a supplier', async () => {
    renderSheet();
    await screen.findByDisplayValue('48.20');
    fireEvent.click(
      await screen.findByRole('button', { name: 'New supplier…' }),
    );
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'Citybee Eesti OÜ' },
    });
    fireEvent.change(screen.getByLabelText('Country'), {
      target: { value: 'EE' },
    });
    expect(screen.getByRole('button', { name: 'Add supplier' })).toBeDisabled();
  });

  it('auto-computes VAT at 22% while the VAT field is untouched, then stops', async () => {
    renderSheet();
    const gross = await screen.findByLabelText(/amount \(eur\)/i);
    fireEvent.change(gross, { target: { value: '100.00' } });
    // 10000 * 22 / 122 = 1803
    expect(screen.getByDisplayValue('18.03')).toBeInTheDocument();
    // Exact-string match: a /vat/i regex would also hit "VAT marking".
    const vat = screen.getByLabelText('VAT');
    fireEvent.change(vat, { target: { value: '0.00' } });
    fireEvent.change(gross, { target: { value: '50.00' } });
    expect(screen.getByDisplayValue('0.00')).toBeInTheDocument(); // manual VAT kept
  });

  it('shows the "usually" hint from the supplier history once a supplier is picked', async () => {
    renderSheet();
    fireEvent.change(await screen.findByPlaceholderText(/search suppliers/i), {
      target: { value: 'circle' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Circle K Eesti AS/ }));
    expect(
      await screen.findByText('Usually Fuel · 2 of 3'),
    ).toBeInTheDocument();
  });

  it('disables submit without a supplier, submits cents payload once valid', async () => {
    const onDone = renderSheet();
    const submit = await screen.findByRole('button', {
      name: 'Create expense · −48.20 €',
    });
    expect(submit).toBeDisabled(); // no supplier yet
    fireEvent.change(screen.getByPlaceholderText(/search suppliers/i), {
      target: { value: 'circle' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Circle K Eesti AS/ }));
    await waitFor(() => expect(submit).toBeEnabled());
    fireEvent.click(submit);
    await waitFor(() =>
      expect(api.manualClassify).toHaveBeenCalledWith(12, {
        supplier_id: 3,
        category: 'fuel',
        document_vat_marking: null,
        gross_amount: 4820,
        vat_amount: 867,
        currency: 'EUR',
        tax_point_date: '2026-07-01',
        supplier_invoice_number: null,
      }),
    );
    expect(onDone).toHaveBeenCalledWith({
      kind: 'expense',
      document_id: 12,
      expense_id: 700,
    });
  });

  it('expands the full category list behind "All…"', async () => {
    renderSheet();
    await screen.findByDisplayValue('48.20');
    fireEvent.click(screen.getByRole('button', { name: 'All…' }));
    expect(
      screen.getByRole('button', { name: 'Software & IT' }),
    ).toBeInTheDocument();
  });
});
