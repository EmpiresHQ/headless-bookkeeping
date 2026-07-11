import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  getPendingDraft: vi.fn(),
  getEntities: vi.fn(),
  onboardEntity: vi.fn(),
  resolveSupplier: vi.fn(),
}));

import * as api from '../api';
import { ResolveSupplierSheet } from './ResolveSupplierSheet';

const OUTCOME = { kind: 'expense', document_id: 12, expense_id: 500 } as const;

function renderSheet(onDone = vi.fn()) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <ResolveSupplierSheet
        documentId={12}
        open
        onOpenChange={() => undefined}
        onDone={onDone}
      />
    </QueryClientProvider>,
  );
  return onDone;
}

describe('ResolveSupplierSheet', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getPendingDraft).mockResolvedValue({
      document_id: 12,
      reason: 'supplier unresolved',
      supplier_proposal: {
        kind: 'create',
        create_name: 'Circle K Eesti AS',
        create_country: 'EE',
        create_registration_key: 'EE100511246',
        create_email: null,
        create_phone: null,
        create_address: null,
      },
      draft: {
        category: 'fuel',
        gross_amount: 4820,
        vat_amount: 867,
        currency: 'EUR',
        tax_point_date: '2026-07-01',
        supplier_invoice_number: null,
      },
    });
    vi.mocked(api.getEntities).mockResolvedValue([
      {
        id: 3,
        role: 'supplier',
        country: 'EE',
        name: 'Wolt Eesti OÜ',
        goods_vs_services: null,
      },
    ]);
    vi.mocked(api.resolveSupplier).mockResolvedValue(OUTCOME);
  });

  it('prefills the proposal and states the outcome with the amount on the primary', async () => {
    renderSheet();
    expect(
      await screen.findByDisplayValue('Circle K Eesti AS'),
    ).toBeInTheDocument();
    expect(screen.getByDisplayValue('EE100511246')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Create supplier & book · −48.20 €' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/fuel/)).toBeInTheDocument();
  });

  it('creates the supplier then resolves the document', async () => {
    vi.mocked(api.onboardEntity).mockResolvedValue({
      id: 9,
      role: 'supplier',
      country: 'EE',
      name: 'Circle K Eesti AS',
      goods_vs_services: null,
    });
    const onDone = renderSheet();
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Create supplier & book · −48.20 €',
      }),
    );
    await waitFor(() =>
      expect(api.onboardEntity).toHaveBeenCalledWith({
        role: 'supplier',
        name: 'Circle K Eesti AS',
        country: 'EE',
        registrationKey: 'EE100511246',
      }),
    );
    await waitFor(() =>
      expect(api.resolveSupplier).toHaveBeenCalledWith(12, 9),
    );
    expect(onDone).toHaveBeenCalledWith(OUTCOME);
  });

  it('requires the registration key for create', async () => {
    renderSheet();
    const regKey = await screen.findByDisplayValue('EE100511246');
    fireEvent.change(regKey, { target: { value: '  ' } });
    expect(
      screen.getByRole('button', { name: 'Create supplier & book · −48.20 €' }),
    ).toBeDisabled();
  });

  it('picks an existing supplier via search', async () => {
    const onDone = renderSheet();
    fireEvent.change(await screen.findByPlaceholderText(/search suppliers/i), {
      target: { value: 'wolt' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Wolt Eesti OÜ/ }));
    await waitFor(() =>
      expect(api.resolveSupplier).toHaveBeenCalledWith(12, 3),
    );
    expect(onDone).toHaveBeenCalledWith(OUTCOME);
  });

  // Reg. key is the 3rd textbox (Name, Country, Reg. key); the search box is a
  // type="search" searchbox, so it is excluded from getAllByRole('textbox').
  const regKeyInput = () => screen.getAllByRole('textbox')[2];

  it('prefills a create proposal with a NULL registration key without crashing', async () => {
    // Regression for the production crash "Cannot read properties of null
    // (reading 'trim')": create_registration_key is `string | null`. A null
    // value used to land in regKey state and blow up `regKey.trim()` during
    // render. It must prefill as an empty string instead.
    vi.mocked(api.getPendingDraft).mockResolvedValue({
      document_id: 12,
      reason: 'supplier unresolved',
      supplier_proposal: {
        kind: 'create',
        create_name: 'Bolt Operations OÜ',
        create_country: 'EE',
        create_registration_key: null,
        create_email: null,
        create_phone: null,
        create_address: null,
      },
      draft: {
        category: 'transport',
        gross_amount: 1599,
        vat_amount: 288,
        currency: 'EUR',
        tax_point_date: '2026-07-08',
        supplier_invoice_number: null,
      },
    });
    renderSheet();
    // Renders without crashing; name prefilled, reg key empty.
    expect(
      await screen.findByDisplayValue('Bolt Operations OÜ'),
    ).toBeInTheDocument();
    expect(regKeyInput()).toHaveValue('');
    // Create is gated on the (missing) reg key…
    expect(
      screen.getByRole('button', { name: /Create supplier & book/ }),
    ).toBeDisabled();
    // …and typing one in enables it — the field is live, not frozen.
    fireEvent.change(regKeyInput(), { target: { value: 'EE102139798' } });
    expect(
      screen.getByRole('button', { name: /Create supplier & book/ }),
    ).toBeEnabled();
  });

  it('prefills an invalid_match proposal from observed identifiers without crashing', async () => {
    vi.mocked(api.getPendingDraft).mockResolvedValue({
      document_id: 12,
      reason: 'match proposal references entity 705731, which does not exist',
      supplier_proposal: {
        kind: 'invalid_match',
        observed_country: 'EE',
        observed_registration_key: 'EE102139798',
        suggested_supplier: {
          id: 37,
          name: 'Citybee Eesti OÜ',
          country: 'EE',
          registration_key: 'EE102139798',
        },
      },
      draft: {
        category: 'transport',
        gross_amount: 1599,
        vat_amount: 288,
        currency: 'EUR',
        tax_point_date: '2026-07-08',
        supplier_invoice_number: null,
      },
    });
    const onDone = renderSheet();
    // Country + reg key prefill from the observed identifiers; name stays empty
    // (the invalid match carries no trustworthy name). No crash.
    expect(await screen.findByDisplayValue('EE102139798')).toBeInTheDocument();
    const [nameInput] = screen.getAllByRole('textbox');
    expect(nameInput).toHaveValue('');
    // Resolving to an existing supplier via search still works end to end.
    fireEvent.change(screen.getByPlaceholderText(/search suppliers/i), {
      target: { value: 'wolt' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Wolt Eesti OÜ/ }));
    await waitFor(() =>
      expect(api.resolveSupplier).toHaveBeenCalledWith(12, 3),
    );
    expect(onDone).toHaveBeenCalledWith(OUTCOME);
  });

  it('prefills an invalid_match proposal with all-null observed identifiers without crashing', async () => {
    vi.mocked(api.getPendingDraft).mockResolvedValue({
      document_id: 12,
      reason: 'supplier could not be resolved',
      supplier_proposal: {
        kind: 'invalid_match',
        observed_country: null,
        observed_registration_key: null,
        suggested_supplier: null,
      },
      draft: {
        category: 'transport',
        gross_amount: 1599,
        vat_amount: 288,
        currency: 'EUR',
        tax_point_date: '2026-07-08',
        supplier_invoice_number: null,
      },
    });
    renderSheet();
    // All three fields render empty, no crash; create is gated until filled.
    await waitFor(() => expect(screen.getAllByRole('textbox')).toHaveLength(3));
    for (const box of screen.getAllByRole('textbox')) {
      expect(box).toHaveValue('');
    }
    expect(
      screen.getByRole('button', { name: /Create supplier & book/ }),
    ).toBeDisabled();
  });
});
