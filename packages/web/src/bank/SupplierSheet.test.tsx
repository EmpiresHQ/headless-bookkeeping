import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  listBankStatements: vi.fn(),
  listBankTransactions: vi.fn(),
  getReconciliationStatus: vi.fn(),
  getStatementMatches: vi.fn(),
  proposeMatches: vi.fn(),
  getMatchCandidates: vi.fn(),
  getBankImportStatus: vi.fn(),
  executeMatches: vi.fn(),
  manualMatch: vi.fn(),
  unmatchMatch: vi.fn(),
  approveApproval: vi.fn(),
  getPendingApprovals: vi.fn(),
  createExpense: vi.fn(),
  postExpense: vi.fn(),
  getCategories: vi.fn(),
  getEntities: vi.fn(),
  getOrganization: vi.fn(),
  onboardEntity: vi.fn(),
  addEntityAlias: vi.fn(),
}));

import * as api from '../api';
import { SupplierSheet } from './SupplierSheet';

const TX = {
  id: 9,
  transaction_date: '2026-06-25',
  description: 'PARTNER GRUPP OU ARVE 4471',
  amount: -24000,
  currency: 'EUR',
  counterparty_iban: 'EE912200221012345678',
  counterparty_descriptor: null,
  reference: null,
  status: 'open',
} as const;

function renderSheet(onPick = vi.fn()) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <SupplierSheet
        open
        onOpenChange={vi.fn()}
        tx={TX as never}
        onPick={onPick}
      />
    </QueryClientProvider>,
  );
  return onPick;
}

describe('SupplierSheet', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getEntities).mockResolvedValue([
      {
        id: 12,
        role: 'supplier',
        country: 'EE',
        name: 'Wolt Eesti OÜ',
        goods_vs_services: null,
      },
      {
        id: 13,
        role: 'customer',
        country: 'EE',
        name: 'Nordic Consulting OÜ',
        goods_vs_services: null,
      },
    ]);
    vi.mocked(api.getOrganization).mockResolvedValue({
      id: 1,
      country: 'EE',
      base_currency: 'EUR',
      vat_registered: true,
      org_type: 'company',
      created_at: 0,
      name: null,
      vat_registration_number: null,
      iban: null,
    });
  });

  it('lists only suppliers, filters by search, picks on tap', async () => {
    const onPick = renderSheet();
    expect(await screen.findByText('Wolt Eesti OÜ')).toBeInTheDocument();
    expect(screen.queryByText('Nordic Consulting OÜ')).toBeNull();
    fireEvent.click(screen.getByText('Wolt Eesti OÜ'));
    expect(onPick).toHaveBeenCalledWith(
      expect.objectContaining({ id: 12, name: 'Wolt Eesti OÜ' }),
    );
  });

  it('creates a new supplier (reg key required) and writes the line aliases back', async () => {
    vi.mocked(api.onboardEntity).mockResolvedValue({
      id: 40,
      role: 'supplier',
      country: 'EE',
      name: 'Partner Grupp OÜ',
      goods_vs_services: null,
    });
    vi.mocked(api.addEntityAlias).mockResolvedValue({} as never);
    const onPick = renderSheet();
    fireEvent.click(
      await screen.findByRole('button', { name: /new supplier/i }),
    );
    // Name is prefilled from the line text.
    expect(screen.getByLabelText('Name')).toHaveValue(
      'PARTNER GRUPP OU ARVE 4471',
    );
    const create = screen.getByRole('button', { name: /create supplier/i });
    expect(create).toBeDisabled(); // reg key required by the server
    fireEvent.change(screen.getByLabelText('Reg. key'), {
      target: { value: 'EE102030405' },
    });
    fireEvent.click(create);
    await vi.waitFor(() =>
      expect(api.onboardEntity).toHaveBeenCalledWith({
        role: 'supplier',
        country: 'EE',
        name: 'PARTNER GRUPP OU ARVE 4471',
        registrationKey: 'EE102030405',
      }),
    );
    // IBAN alias + name alias from the line → the server matcher learns.
    await vi.waitFor(() =>
      expect(api.addEntityAlias).toHaveBeenCalledWith(40, {
        kind: 'iban',
        value: 'EE912200221012345678',
      }),
    );
    await vi.waitFor(() =>
      expect(api.addEntityAlias).toHaveBeenCalledWith(40, {
        kind: 'name_alias',
        value: 'PARTNER GRUPP OU ARVE 4471',
      }),
    );
    await vi.waitFor(() =>
      expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: 40 })),
    );
  });
});
