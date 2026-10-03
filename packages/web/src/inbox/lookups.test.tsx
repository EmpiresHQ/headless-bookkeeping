import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  getDocumentDetails: vi.fn(),
  getDocumentReclassify: vi.fn(),
  getCategories: vi.fn(),
  getEntities: vi.fn(),
  getExpenses: vi.fn(),
  manualClassify: vi.fn(),
  manualClassifyInvoice: vi.fn(),
  onboardEntity: vi.fn(),
  fetchDocumentFile: vi.fn(),
}));

import * as api from '../api';
import { UnsavedChangesProvider } from '../lib/unsavedChanges';
import { sharedKeys } from '../queries/keys';
import { ClassifyExpenseSheet } from './ClassifyExpenseSheet';
import { ClassifyInvoiceSheet } from './ClassifyInvoiceSheet';

function wrap(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <UnsavedChangesProvider onUnauthorized={() => undefined}>
        {ui}
      </UnsavedChangesProvider>
    </QueryClientProvider>,
  );
  return client;
}

const CIRCLE = {
  id: 3,
  role: 'supplier',
  country: 'EE',
  name: 'Circle K Eesti AS',
  goods_vs_services: null,
  tax_status: null,
} as const;
const CREATED = { ...CIRCLE, id: 41, name: 'Brand New OÜ' };
const CUSTOMER = { ...CIRCLE, id: 4, role: 'customer', name: 'Nordic OÜ' };

const classification = (category: string) => ({
  ok: true as const,
  result: {
    kind: 'new_expense',
    document_type: 'receipt',
    gross_amount: 4820,
    vat_amount: 867,
    currency: 'EUR',
    tax_point_date: '2026-07-01',
    category,
    document_vat_marking: null,
    supplier_invoice_number: '2026-018',
    confidence: 0.41,
  },
});

const expenseSheet = () => (
  <ClassifyExpenseSheet
    documentId={12}
    open
    onOpenChange={vi.fn()}
    onDone={vi.fn()}
  />
);
const createBtn = () => screen.getByRole('button', { name: /Create expense/ });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.fetchDocumentFile).mockResolvedValue({
    blob: new Blob(['x'], { type: 'image/png' }),
    filename: 'r.png',
  });
  vi.mocked(api.getDocumentDetails).mockResolvedValue({
    document_id: 12,
    ocr: { ok: true, markdown: '…' },
    classification: classification('fuel'),
  } as never);
  vi.mocked(api.getDocumentReclassify).mockResolvedValue({
    document_id: 12,
    ocr: { ok: true, markdown: '…' },
    classification: classification(''),
  } as never);
  vi.mocked(api.getCategories).mockResolvedValue([
    { key: 'fuel', label: 'Fuel', accountCode: '5000' },
  ]);
  vi.mocked(api.getEntities).mockResolvedValue([CIRCLE, CUSTOMER] as never);
  vi.mocked(api.getExpenses).mockResolvedValue([]);
});

describe('ClassifyExpenseSheet — reference-data states (#260)', () => {
  it('entities 503: never "No matches — create it"; Retry; creation only with a caution', async () => {
    vi.mocked(api.getEntities).mockRejectedValueOnce(new Error('HTTP 503'));
    wrap(expenseSheet());
    expect(
      await screen.findByText(/Couldn't load suppliers \(HTTP 503\)/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/No matches — create it/)).toBeNull();
    expect(
      screen.getByText(/an existing supplier may not be shown/),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New supplier…' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Retry suppliers' }));
    expect(await screen.findByText('Circle K Eesti AS')).toBeInTheDocument();
  });

  it('categories 503: the prefilled category stays visible but unverified, and blocks until the list loads', async () => {
    vi.mocked(api.getCategories).mockRejectedValueOnce(new Error('HTTP 503'));
    wrap(expenseSheet());
    fireEvent.click(await screen.findByText('Circle K Eesti AS'));
    expect(await screen.findByText('fuel (unverified)')).toBeInTheDocument();
    expect(createBtn()).toBeDisabled();
    expect(
      screen.getByText("Couldn't load categories — retry above."),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry categories' }));
    await waitFor(() => expect(createBtn()).toBeEnabled());
    expect(screen.getByRole('button', { name: 'Fuel' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('a prefilled category the list does not offer is shown and must be corrected — never sent unseen', async () => {
    vi.mocked(api.getDocumentDetails).mockResolvedValue({
      document_id: 12,
      ocr: { ok: true, markdown: '…' },
      classification: classification('mystery'),
    } as never);
    wrap(expenseSheet());
    fireEvent.click(await screen.findByText('Circle K Eesti AS'));
    expect(
      await screen.findByText('mystery (not available)'),
    ).toBeInTheDocument();
    expect(createBtn()).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Fuel' }));
    expect(createBtn()).toBeEnabled();
    expect(api.manualClassify).not.toHaveBeenCalled();
  });

  it('a supplier created here survives a failed refresh, then blocks when a later successful list lacks it; input is kept', async () => {
    vi.mocked(api.onboardEntity).mockResolvedValue(CREATED as never);
    const client = wrap(expenseSheet());
    await screen.findByText('Circle K Eesti AS');
    fireEvent.click(screen.getByRole('button', { name: 'New supplier…' }));
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'Brand New OÜ' },
    });
    fireEvent.change(screen.getByLabelText('Country'), {
      target: { value: 'EE' },
    });
    fireEvent.change(screen.getByLabelText('Reg. key'), {
      target: { value: 'EE9' },
    });
    vi.mocked(api.getEntities).mockRejectedValueOnce(new Error('HTTP 503'));
    fireEvent.click(screen.getByRole('button', { name: 'Add supplier' }));
    expect(await screen.findByText('Brand New OÜ')).toBeInTheDocument();
    await waitFor(() => expect(createBtn()).toBeEnabled());

    vi.mocked(api.getEntities).mockResolvedValue([CIRCLE] as never);
    await act(() => client.refetchQueries({ queryKey: sharedKeys.entities }));
    expect(
      await screen.findByText(
        'This supplier is no longer available — change it',
      ),
    ).toBeInTheDocument();
    expect(createBtn()).toBeDisabled();
    expect(screen.getByDisplayValue('48.20')).toBeInTheDocument();
    expect(api.manualClassify).not.toHaveBeenCalled();
  });
});

describe('ClassifyInvoiceSheet — reference-data states (#260)', () => {
  const invoiceSheet = () => (
    <ClassifyInvoiceSheet
      documentId={12}
      open
      onOpenChange={vi.fn()}
      onDone={vi.fn()}
    />
  );
  const submit = () => screen.getByRole('button', { name: /Record invoice/ });

  it('customers 503: no "leave empty" claim, blocked with Retry; a fresh list allows none', async () => {
    vi.mocked(api.getEntities).mockRejectedValueOnce(new Error('HTTP 503'));
    wrap(invoiceSheet());
    expect(
      await screen.findByText(/Couldn't load customers \(HTTP 503\)/),
    ).toBeInTheDocument();
    await screen.findByDisplayValue('48.20');
    expect(screen.queryByText(/leave empty if unknown/)).toBeNull();
    expect(submit()).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Retry customers' }));
    expect(await screen.findByText('Nordic OÜ')).toBeInTheDocument();
    await waitFor(() => expect(submit()).toBeEnabled());
  });

  it('a picked customer a later list drops blocks until changed', async () => {
    const client = wrap(invoiceSheet());
    fireEvent.click(await screen.findByText('Nordic OÜ'));
    await screen.findByDisplayValue('48.20');
    await waitFor(() => expect(submit()).toBeEnabled());
    vi.mocked(api.getEntities).mockResolvedValue([CIRCLE] as never);
    await act(() => client.refetchQueries({ queryKey: sharedKeys.entities }));
    expect(
      await screen.findByText(/Nordic OÜ — no longer available/),
    ).toBeInTheDocument();
    expect(submit()).toBeDisabled();
    // The Field's <label> names the button; find it by its text.
    fireEvent.click(screen.getByText('Change'));
    expect(submit()).toBeEnabled();
    expect(api.manualClassifyInvoice).not.toHaveBeenCalled();
  });

  it('a picked customer keeps the refresh warning and Retry visible', async () => {
    const client = wrap(invoiceSheet());
    fireEvent.click(await screen.findByText('Nordic OÜ'));
    vi.mocked(api.getEntities).mockRejectedValueOnce(new Error('HTTP 503'));
    await act(() => client.refetchQueries({ queryKey: sharedKeys.entities }));
    expect(
      await screen.findByText(/Couldn't refresh customers/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Retry customers' }),
    ).toBeInTheDocument();
    // The cached pick is still usable.
    await waitFor(() => expect(submit()).toBeEnabled());
  });
});

describe('ClassifyExpenseSheet — more states (#260)', () => {
  it('a known-empty category list is stated and blocks', async () => {
    vi.mocked(api.getCategories).mockResolvedValue([]);
    wrap(expenseSheet());
    fireEvent.click(await screen.findByText('Circle K Eesti AS'));
    expect(
      (await screen.findAllByText(/No expense categories are defined/)).length,
    ).toBeGreaterThan(0);
    expect(createBtn()).toBeDisabled();
  });

  it('a picked supplier keeps the refresh warning and Retry visible', async () => {
    const client = wrap(expenseSheet());
    fireEvent.click(await screen.findByText('Circle K Eesti AS'));
    vi.mocked(api.getEntities).mockRejectedValueOnce(new Error('HTTP 503'));
    await act(() => client.refetchQueries({ queryKey: sharedKeys.entities }));
    expect(
      await screen.findByText(/Couldn't refresh suppliers/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Retry suppliers' }),
    ).toBeInTheDocument();
    await waitFor(() => expect(createBtn()).toBeEnabled());
  });
});
