import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api', () => ({
  getCategories: vi.fn(),
  getEntities: vi.fn(),
  getExpenses: vi.fn(),
  getInvoices: vi.fn(),
  getOrganization: vi.fn(),
  getReportingPeriods: vi.fn(),
}));

import * as api from '../api';
import { sharedKeys } from './keys';
import { useCustomers, useSuppliers } from './shared';

function makeWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
  };
  return { client, wrapper };
}

describe('shared query keys', () => {
  it('preserves the exact legacy literals for cache compatibility', () => {
    expect(sharedKeys.entities).toEqual(['entities']);
    expect(sharedKeys.categories).toEqual(['categories']);
    expect(sharedKeys.organization).toEqual(['organization']);
  });
});

describe('shared hooks', () => {
  beforeEach(() => vi.clearAllMocks());

  it('useSuppliers and useCustomers share ONE entities cache entry and filter by role', async () => {
    vi.mocked(api.getEntities).mockResolvedValue([
      { id: 1, role: 'supplier', country: 'EE', name: 'Wolt', goods_vs_services: null },
      { id: 2, role: 'customer', country: 'EE', name: 'Nordic', goods_vs_services: null },
    ]);
    const { client, wrapper } = makeWrapper();
    const suppliers = renderHook(() => useSuppliers(), { wrapper });
    const customers = renderHook(() => useCustomers(), { wrapper });
    await waitFor(() => expect(suppliers.result.current.isSuccess).toBe(true));
    await waitFor(() => expect(customers.result.current.isSuccess).toBe(true));
    expect(api.getEntities).toHaveBeenCalledTimes(1); // one cache entry
    expect(suppliers.result.current.data).toEqual([
      expect.objectContaining({ name: 'Wolt' }),
    ]);
    expect(customers.result.current.data).toEqual([
      expect.objectContaining({ name: 'Nordic' }),
    ]);
    expect(client.getQueryData(sharedKeys.entities)).toHaveLength(2);
  });
});
