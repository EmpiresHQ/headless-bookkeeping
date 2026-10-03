import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  getCategories: vi.fn(),
  getEntities: vi.fn(),
  getOrganization: vi.fn(),
  onboardEntity: vi.fn(),
  addEntityAlias: vi.fn(),
  createExpense: vi.fn(),
}));

import * as api from '../api';
import { usePendingOperation } from '../lib/pendingOperation';
import { UnsavedChangesProvider } from '../lib/unsavedChanges';
import { sharedKeys } from '../queries/keys';
import { SupplierSheet } from './SupplierSheet';
import { TxCreateExpense } from './TxCreateExpense';

const TX = {
  id: 9,
  transaction_date: '2026-06-27',
  description: 'PARTNER GRUPP',
  amount: -1860,
  currency: 'EUR',
  counterparty_iban: null,
  counterparty_descriptor: null,
  reference: null,
  status: 'open',
} as const;

const ORG = {
  id: 1,
  country: 'LV',
  base_currency: 'EUR',
  vat_registered: true,
  vat_registration_kind: 'ordinary',
  input_vat_entitlement: 'full',
  input_vat_deduction_permille: null,
  org_type: 'company',
  created_at: 0,
  name: null,
  registry_code: null,
  vat_registration_number: null,
  iban: null,
} as const;

const WOLT = {
  id: 12,
  role: 'supplier',
  country: 'EE',
  name: 'Wolt Eesti OÜ',
  goods_vs_services: null,
  tax_status: null,
} as const;
const CREATED = { ...WOLT, id: 40, name: 'Partner Grupp OÜ' };

function wrap(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <UnsavedChangesProvider onUnauthorized={() => undefined}>
          {ui}
        </UnsavedChangesProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return client;
}

function CreateWithOp() {
  const op = usePendingOperation('Bank line');
  return (
    <TxCreateExpense
      statementId={3}
      tx={TX as never}
      op={op}
      onDone={vi.fn()}
    />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getCategories).mockResolvedValue([
    { key: 'meals', label: 'Meals', accountCode: 'EXPENSE_MEALS' },
  ]);
  vi.mocked(api.getEntities).mockResolvedValue([WOLT] as never);
  vi.mocked(api.getOrganization).mockResolvedValue(ORG as never);
  vi.mocked(api.addEntityAlias).mockResolvedValue({} as never);
});

describe('SupplierSheet — reference-data states (#260)', () => {
  it('entities 503: no "No suppliers match", a Retry, and creation is offered only with a caution', async () => {
    vi.mocked(api.getEntities).mockRejectedValueOnce(new Error('HTTP 503'));
    wrap(
      <SupplierSheet
        open
        onOpenChange={vi.fn()}
        tx={TX as never}
        onPick={vi.fn()}
      />,
    );
    expect(
      await screen.findByText(/Couldn't load suppliers \(HTTP 503\)/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/No suppliers match/)).toBeNull();
    expect(
      screen.getByText(/an existing supplier may not be shown/),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry suppliers' }));
    expect(await screen.findByText('Wolt Eesti OÜ')).toBeInTheDocument();
    expect(
      screen.queryByText(/an existing supplier may not be shown/),
    ).toBeNull();
  });

  it('organization country 503: no invented EE — explicit country required, Retry fills the real default, a typed one wins', async () => {
    vi.mocked(api.getOrganization).mockRejectedValueOnce(new Error('HTTP 503'));
    vi.mocked(api.onboardEntity).mockResolvedValue(CREATED as never);
    const onPick = vi.fn();
    wrap(
      <SupplierSheet
        open
        onOpenChange={vi.fn()}
        tx={TX as never}
        onPick={onPick}
      />,
    );
    fireEvent.click(
      await screen.findByRole('button', { name: /new supplier/i }),
    );
    fireEvent.change(screen.getByLabelText('Reg. key'), {
      target: { value: 'EE1' },
    });
    expect(
      await screen.findByText(/Couldn't load the organization's country/),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Country')).toHaveValue('');
    const create = screen.getByRole('button', { name: 'Create supplier' });
    expect(create).toBeDisabled();

    fireEvent.click(
      screen.getByRole('button', { name: 'Retry organization country' }),
    );
    await waitFor(() =>
      expect(screen.getByLabelText('Country')).toHaveValue('LV'),
    );
    fireEvent.change(screen.getByLabelText('Country'), {
      target: { value: 'fi' },
    });
    expect(screen.getByLabelText('Country')).toHaveValue('FI');
    fireEvent.click(create);
    await waitFor(() =>
      expect(api.onboardEntity).toHaveBeenCalledWith(
        expect.objectContaining({ country: 'FI', registrationKey: 'EE1' }),
      ),
    );
    await waitFor(() =>
      expect(onPick).toHaveBeenCalledWith(
        expect.objectContaining({ id: 40 }),
        true,
      ),
    );
  });
});

describe('TxCreateExpense — reference-data states (#260)', () => {
  it('categories 503: blocked with a reason and Retry, no empty select', async () => {
    vi.mocked(api.getCategories).mockRejectedValueOnce(new Error('HTTP 503'));
    wrap(<CreateWithOp />);
    expect(
      await screen.findByRole('option', { name: 'Categories unavailable' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Create & match/ }),
    ).toBeDisabled();
    expect(
      screen.getByText("Couldn't load categories — retry above."),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry categories' }));
    await screen.findByRole('option', { name: 'Meals' });
  });

  it('a newly created supplier is kept while the cached list predates it, then blocks once a later successful list lacks it', async () => {
    vi.mocked(api.onboardEntity).mockResolvedValue(CREATED as never);
    const client = wrap(<CreateWithOp />);
    await screen.findByRole('option', { name: 'Meals' });
    fireEvent.change(screen.getByLabelText('Category'), {
      target: { value: 'meals' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Choose or create/ }));
    fireEvent.click(
      await screen.findByRole('button', { name: /new supplier/i }),
    );
    fireEvent.change(await screen.findByLabelText('Reg. key'), {
      target: { value: 'EE1' },
    });
    // The post-creation refresh fails: the cached list (without it) stays.
    vi.mocked(api.getEntities).mockRejectedValueOnce(new Error('HTTP 503'));
    fireEvent.click(screen.getByRole('button', { name: 'Create supplier' }));
    expect(await screen.findByText('Partner Grupp OÜ')).toBeInTheDocument();
    const submit = screen.getByRole('button', { name: /Create & match/ });
    await waitFor(() => expect(submit).toBeEnabled());
    expect(screen.getByText(/Couldn't refresh suppliers/)).toBeInTheDocument();

    // A later SUCCESSFUL list without it: authoritative absence.
    vi.mocked(api.getEntities).mockResolvedValue([WOLT] as never);
    await act(() => client.refetchQueries({ queryKey: sharedKeys.entities }));
    expect(
      await screen.findByText(/Partner Grupp OÜ — no longer available/),
    ).toBeInTheDocument();
    expect(submit).toBeDisabled();
    expect(
      screen.getByText(
        'The chosen supplier is no longer available — choose again.',
      ),
    ).toBeInTheDocument();
    // The category choice survived.
    expect(screen.getByLabelText('Category')).toHaveValue('meals');
    expect(api.createExpense).not.toHaveBeenCalled();
  });

  it('a newly created supplier the refreshed list contains stays valid', async () => {
    vi.mocked(api.onboardEntity).mockResolvedValue(CREATED as never);
    wrap(<CreateWithOp />);
    await screen.findByRole('option', { name: 'Meals' });
    fireEvent.change(screen.getByLabelText('Category'), {
      target: { value: 'meals' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Choose or create/ }));
    fireEvent.click(
      await screen.findByRole('button', { name: /new supplier/i }),
    );
    fireEvent.change(await screen.findByLabelText('Reg. key'), {
      target: { value: 'EE1' },
    });
    vi.mocked(api.getEntities).mockResolvedValue([WOLT, CREATED] as never);
    fireEvent.click(screen.getByRole('button', { name: 'Create supplier' }));
    expect(await screen.findByText('Partner Grupp OÜ')).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /Create & match/ }),
      ).toBeEnabled(),
    );
    expect(screen.queryByText(/no longer available/)).toBeNull();
  });

  it('a known-empty category list blocks with its own reason', async () => {
    vi.mocked(api.getCategories).mockResolvedValue([]);
    wrap(<CreateWithOp />);
    expect(
      await screen.findByRole('option', { name: 'No categories defined' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Create & match/ }),
    ).toBeDisabled();
    expect(
      screen.getAllByText(/No expense categories are defined/).length,
    ).toBeGreaterThan(0);
  });

  it('entities 503 from the start: a newly created supplier is the answer (with a warning) until a fresh list proves its removal', async () => {
    vi.mocked(api.getEntities).mockRejectedValue(new Error('HTTP 503'));
    vi.mocked(api.onboardEntity).mockResolvedValue(CREATED as never);
    const client = wrap(<CreateWithOp />);
    await screen.findByRole('option', { name: 'Meals' });
    fireEvent.change(screen.getByLabelText('Category'), {
      target: { value: 'meals' },
    });
    const submit = screen.getByRole('button', { name: /Create & match/ });
    // No supplier + unknown list: "none" is not an answer.
    expect(
      await screen.findByText("Couldn't load suppliers — retry above."),
    ).toBeInTheDocument();
    expect(submit).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: /Choose or create/ }));
    fireEvent.click(
      await screen.findByRole('button', { name: /new supplier/i }),
    );
    fireEvent.change(await screen.findByLabelText('Reg. key'), {
      target: { value: 'EE1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create supplier' }));
    expect(await screen.findByText('Partner Grupp OÜ')).toBeInTheDocument();
    await waitFor(() => expect(submit).toBeEnabled());
    // The list is still unknown — said so, with its Retry.
    expect(
      screen.getAllByText(/Couldn't load suppliers \(HTTP 503\)/).length,
    ).toBeGreaterThan(0);

    vi.mocked(api.getEntities).mockResolvedValue([WOLT] as never);
    await act(() => client.refetchQueries({ queryKey: sharedKeys.entities }));
    expect(
      await screen.findByText(/Partner Grupp OÜ — no longer available/),
    ).toBeInTheDocument();
    expect(submit).toBeDisabled();
  });
});

describe('SupplierSheet — stale organization country (#260)', () => {
  it('a default from a list whose refresh failed is flagged, with Retry', async () => {
    const client = wrap(
      <SupplierSheet
        open
        onOpenChange={vi.fn()}
        tx={TX as never}
        onPick={vi.fn()}
      />,
    );
    fireEvent.click(
      await screen.findByRole('button', { name: /new supplier/i }),
    );
    await waitFor(() =>
      expect(screen.getByLabelText('Country')).toHaveValue('LV'),
    );
    vi.mocked(api.getOrganization).mockRejectedValueOnce(new Error('HTTP 503'));
    await act(() =>
      client.refetchQueries({ queryKey: sharedKeys.organization }),
    );
    expect(
      await screen.findByText(/as loaded earlier — it could not be refreshed/),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Country')).toHaveValue('LV');
    fireEvent.click(
      screen.getByRole('button', { name: 'Retry organization country' }),
    );
    await waitFor(() =>
      expect(
        screen.queryByText(/as loaded earlier — it could not be refreshed/),
      ).toBeNull(),
    );
  });
});
