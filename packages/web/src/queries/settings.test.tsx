import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../api', async (io) => ({
  ...(await io<typeof import('../api')>()),
  getSettings: vi.fn(),
}));
import {
  getSettings,
  type Entity,
  type EntityIdentifier,
  type Expense,
  type SalesInvoice,
} from '../api';
import { sharedKeys } from './keys';
import {
  ALIAS_KIND_LABEL,
  aliasesOf,
  CLAIMANT_ROLES,
  classificationMemory,
  entityDetailKey,
  entityMatchesQuery,
  entityStats,
  identifierOf,
  invalidateEntities,
  invalidateMailbox,
  invalidateOrganization,
  ROLE_LABEL,
  segmentEntities,
  settingsKeys,
  settingsMap,
  useAdminSettings,
} from './settings';

const entity = (over: Partial<Entity> = {}): Entity =>
  ({
    id: 3,
    role: 'supplier',
    country: 'EE',
    name: 'Circle K Eesti AS',
    goods_vs_services: 'goods',
    ...over,
  }) as Entity;

const ident = (over: Partial<EntityIdentifier>): EntityIdentifier =>
  ({
    id: 1,
    entity_id: 3,
    kind: 'name_alias',
    value: 'x',
    confirmed: true,
    ...over,
  }) as EntityIdentifier;

const expense = (over: Partial<Expense> = {}): Expense =>
  ({
    id: 1,
    supplier_id: 3,
    category: 'fuel',
    gross_amount: 4820,
    vat_amount: 869,
    currency: 'EUR',
    tax_point_date: '2026-06-10',
    status: 'posted',
    reconciled: false,
    supplier_invoice_number: null,
    ...over,
  }) as Expense;

describe('pure model', () => {
  it('role labels and claimant roles mirror the server enum (Reality #4)', () => {
    expect(ROLE_LABEL).toEqual({
      supplier: 'Supplier',
      customer: 'Customer',
      employee: 'Employee',
      director: 'Director',
    });
    expect(CLAIMANT_ROLES).toEqual(['employee', 'director']);
  });

  it('segmentEntities: team = employee + director (ADR-0036 claimants)', () => {
    const rows = [
      entity({ id: 1, role: 'supplier' }),
      entity({ id: 2, role: 'customer' }),
      entity({ id: 3, role: 'employee' }),
      entity({ id: 4, role: 'director' }),
    ];
    expect(segmentEntities(rows, 'all').map((e) => e.id)).toEqual([1, 2, 3, 4]);
    expect(segmentEntities(rows, 'suppliers').map((e) => e.id)).toEqual([1]);
    expect(segmentEntities(rows, 'customers').map((e) => e.id)).toEqual([2]);
    expect(segmentEntities(rows, 'team').map((e) => e.id)).toEqual([3, 4]);
  });

  it('entityMatchesQuery is case-insensitive over the name', () => {
    expect(entityMatchesQuery(entity(), 'circle')).toBe(true);
    expect(entityMatchesQuery(entity(), 'CIRCLE K')).toBe(true);
    expect(entityMatchesQuery(entity(), 'wolt')).toBe(false);
    expect(entityMatchesQuery(entity(), '')).toBe(true);
  });

  it('identifierOf / aliasesOf split identity from aliases', () => {
    const e = entity({
      identifiers: [
        ident({ kind: 'registration_key', value: 'EE100511246' }),
        ident({ id: 2, kind: 'merchant_descriptor', value: 'CIRCLE K 4411' }),
        ident({ id: 3, kind: 'iban', value: 'EE38…', confirmed: false }),
        ident({ id: 4, kind: 'email', value: 'x@y.z' }),
      ],
    });
    expect(identifierOf(e, 'registration_key')).toBe('EE100511246');
    expect(identifierOf(e, 'email')).toBe('x@y.z');
    expect(identifierOf(e, 'phone')).toBeNull();
    expect(aliasesOf(e).map((a) => a.kind)).toEqual([
      'merchant_descriptor',
      'iban',
    ]);
    expect(ALIAS_KIND_LABEL.merchant_descriptor).toBe('Bank-line descriptor');
  });

  it('entityStats: supplier joins non-draft expenses; customer joins invoices; team → null', () => {
    const expenses = [
      expense({ id: 1, gross_amount: 4820 }),
      expense({ id: 2, gross_amount: 1000, status: 'draft' }), // excluded
      expense({ id: 3, gross_amount: 180, supplier_id: 99 }), // other supplier
    ];
    const invoices = [
      {
        id: 7,
        customer_id: 5,
        gross_amount: 12000,
        status: 'posted',
      } as SalesInvoice,
    ];
    expect(entityStats(expenses, invoices, entity())).toEqual({
      label: 'Expenses',
      count: 1,
      totalCents: 4820,
    });
    expect(
      entityStats(expenses, invoices, entity({ id: 5, role: 'customer' })),
    ).toEqual({ label: 'Invoices', count: 1, totalCents: 12000 });
    expect(
      entityStats(expenses, invoices, entity({ id: 9, role: 'employee' })),
    ).toBeNull();
  });

  it('classificationMemory: top posted category with honest counts; null when no posted rows', () => {
    const rows = [
      expense({ id: 1, category: 'fuel' }),
      expense({ id: 2, category: 'fuel', tax_point_date: '2026-06-11' }),
      expense({ id: 3, category: 'office', tax_point_date: '2026-06-12' }),
      expense({ id: 4, category: 'fuel', status: 'draft' }), // not evidence
    ];
    expect(classificationMemory(rows, 3)).toEqual({
      category: 'fuel',
      count: 2,
      of: 3,
    });
    expect(classificationMemory(rows, 42)).toBeNull();
  });

  it('settingsMap folds the list into a record', () => {
    expect(
      settingsMap([
        { key: 'ai_model', value: 'openai/gpt-4o-mini' },
        { key: 'public_api_url', value: 'https://api.example.com' },
      ]),
    ).toEqual({
      ai_model: 'openai/gpt-4o-mini',
      public_api_url: 'https://api.example.com',
    });
  });
});

describe('keys and invalidation', () => {
  it('entity detail nests under the FROZEN entities prefix', () => {
    expect(entityDetailKey(7)).toEqual(['entities', 'detail', 7]);
    expect(settingsKeys.all).toEqual(['settings']);
  });

  it('invalidators fan out per the binding rules', async () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    await invalidateEntities(qc);
    await invalidateOrganization(qc);
    await invalidateMailbox(qc);
    const keys = spy.mock.calls.map((c) => c[0]?.queryKey);
    expect(keys).toContainEqual(sharedKeys.entities);
    expect(keys).toContainEqual(sharedKeys.organization);
    expect(keys).toContainEqual(['reports']);
    expect(keys).toContainEqual(settingsKeys.mailbox);
    expect(keys).toContainEqual(['inbox']);
  });
});

describe('hooks', () => {
  it('useAdminSettings selects the map', async () => {
    vi.mocked(getSettings).mockResolvedValue([
      { key: 'ingest_policy', value: 'quarantine' },
    ]);
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useAdminSettings(), { wrapper });
    await waitFor(() =>
      expect(result.current.data).toEqual({ ingest_policy: 'quarantine' }),
    );
  });
});
