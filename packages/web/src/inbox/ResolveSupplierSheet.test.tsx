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
        create_name: 'Circle K Eesti AS',
        create_country: 'EE',
        create_registration_key: 'EE100511246',
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
      screen.getByRole('button', { name: 'Create supplier & book · -48.20 €' }),
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
        name: 'Create supplier & book · -48.20 €',
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
      screen.getByRole('button', { name: 'Create supplier & book · -48.20 €' }),
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
});
