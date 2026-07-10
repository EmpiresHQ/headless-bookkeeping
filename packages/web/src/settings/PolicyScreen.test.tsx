import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  render,
  screen,
  fireEvent,
  waitFor,
  act,
} from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../api', async (io) => ({
  ...(await io<typeof import('../api')>()),
  getPolicyConfig: vi.fn(),
  updatePolicyConfig: vi.fn(),
  getSettings: vi.fn(),
  setSetting: vi.fn(),
}));
import {
  getPolicyConfig,
  getSettings,
  setSetting,
  updatePolicyConfig,
  type PolicyConfig,
} from '../api';
import { settingsKeys } from '../queries/settings';
import { AppToaster } from '../ui/toast';
import { PolicyScreen } from './PolicyScreen';

const POLICY: PolicyConfig = {
  auto_post_amount_ceiling: 5000,
  auto_post_min_confidence: 0.8,
  unknown_supplier_requires_approval: true,
  always_approve_operations: ['credit_note'],
};

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/settings/policy']}>
        <PolicyScreen />
      </MemoryRouter>
      <AppToaster />
    </QueryClientProvider>,
  );
  return qc;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getPolicyConfig).mockResolvedValue(POLICY);
  vi.mocked(getSettings).mockResolvedValue([
    { key: 'ingest_policy', value: 'quarantine' },
  ]);
});

describe('PolicyScreen', () => {
  it('prefills the ceiling in EUROS and explains the effect live', async () => {
    mount();
    await waitFor(() =>
      expect(screen.getByLabelText('Auto-post ceiling (€)')).toHaveValue(
        '50.00',
      ),
    );
    expect(
      screen.getByText('Expenses above 50.00 € are held for approval'),
    ).toBeInTheDocument();
  });

  it('saves comma-decimal euros as integer cents (the cent bug stays dead)', async () => {
    vi.mocked(updatePolicyConfig).mockResolvedValue({
      ...POLICY,
      auto_post_amount_ceiling: 12050,
    });
    mount();
    await screen.findByLabelText('Auto-post ceiling (€)');
    fireEvent.change(screen.getByLabelText('Auto-post ceiling (€)'), {
      target: { value: '120,50' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save policy' }));
    await waitFor(() =>
      expect(updatePolicyConfig).toHaveBeenCalledWith({
        auto_post_amount_ceiling: 12050,
        auto_post_min_confidence: 0.8,
        unknown_supplier_requires_approval: true,
        always_approve_operations: ['credit_note'],
      }),
    );
    expect(await screen.findByText('Policy saved')).toBeInTheDocument();
  });

  it('blocks save on an unparseable amount or out-of-range confidence', async () => {
    mount();
    await screen.findByLabelText('Auto-post ceiling (€)');
    fireEvent.change(screen.getByLabelText('Auto-post ceiling (€)'), {
      target: { value: 'fifty' },
    });
    expect(screen.getByRole('button', { name: 'Save policy' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Auto-post ceiling (€)'), {
      target: { value: '50.00' },
    });
    fireEvent.change(screen.getByLabelText('Minimum AI confidence (0–1)'), {
      target: { value: '1.5' },
    });
    expect(screen.getByRole('button', { name: 'Save policy' })).toBeDisabled();
    expect(updatePolicyConfig).not.toHaveBeenCalled();
  });

  it('ingest policy select writes the setting key immediately', async () => {
    vi.mocked(setSetting).mockResolvedValue({
      key: 'ingest_policy',
      value: 'open',
    });
    mount();
    await waitFor(() =>
      expect(screen.getByLabelText('Ingest policy')).toHaveValue('quarantine'),
    );
    fireEvent.change(screen.getByLabelText('Ingest policy'), {
      target: { value: 'open' },
    });
    await waitFor(() =>
      expect(setSetting).toHaveBeenCalledWith('ingest_policy', 'open'),
    );
  });

  it('keeps a dirty risk-gate draft through a background refetch (>staleTime tab-away)', async () => {
    const qc = mount();
    await screen.findByLabelText('Auto-post ceiling (€)');
    fireEvent.change(screen.getByLabelText('Auto-post ceiling (€)'), {
      target: { value: '99.00' },
    });
    // Simulate a background refetch (staleTime elapsed + refetchOnWindowFocus)
    // landing a fresh server snapshot in the cache while the operator is
    // mid-edit — the old `key={dataUpdatedAt}` remount used to clobber this.
    act(() => {
      qc.setQueryData(settingsKeys.policy, {
        ...POLICY,
        auto_post_amount_ceiling: 7000,
      });
    });
    expect(screen.getByLabelText('Auto-post ceiling (€)')).toHaveValue('99.00');
  });
});
