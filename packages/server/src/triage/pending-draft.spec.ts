import type { EntitiesService } from '../entities/entities.service';
import type { EntityWithIdentifiers } from '../entities/types';
import { buildPendingSupplierProposal } from './pending-draft';
import type { SupplierProposal } from './types';

type Resolver = Pick<EntitiesService, 'resolveByIdentifier'>;

const resolverReturning = (
  entity: EntityWithIdentifiers | undefined,
): { resolver: Resolver; calls: Array<[string, string]> } => {
  const calls: Array<[string, string]> = [];
  return {
    calls,
    resolver: {
      resolveByIdentifier: async (kind: string, value: string) => {
        calls.push([kind, value]);
        return entity;
      },
    },
  };
};

const supplier = (over: Partial<EntityWithIdentifiers> = {}): EntityWithIdentifiers => ({
  id: 37,
  role: 'supplier',
  country: 'EE',
  name: 'Citybee Eesti OÜ',
  goods_vs_services: null,
  created_at: null,
  updated_at: null,
  identifiers: [],
  ...over,
});

describe('buildPendingSupplierProposal', () => {
  it('passes a create proposal through as a create read model', async () => {
    const proposal: SupplierProposal = {
      mode: 'create',
      create_name: 'New Vendor OÜ',
      create_country: 'EE',
      create_registration_key: 'EE123',
      create_email: null,
      create_phone: null,
      create_address: null,
    };
    const { resolver, calls } = resolverReturning(undefined);

    const result = await buildPendingSupplierProposal(proposal, resolver);

    expect(result).toEqual({
      kind: 'create',
      create_name: 'New Vendor OÜ',
      create_country: 'EE',
      create_registration_key: 'EE123',
      create_email: null,
      create_phone: null,
      create_address: null,
    });
    // A create proposal never triggers an identifier lookup.
    expect(calls).toHaveLength(0);
  });

  it('resolves an invalid match to a strong-identifier suggestion, never leaking the stale entity id', async () => {
    const proposal: SupplierProposal = {
      mode: 'match',
      match_entity_id: 705731,
      observed_country: 'EE',
      observed_registration_key: 'ee 102139798',
    };
    const { resolver, calls } = resolverReturning(supplier());

    const result = await buildPendingSupplierProposal(proposal, resolver);

    expect(result).toEqual({
      kind: 'invalid_match',
      observed_country: 'EE',
      observed_registration_key: 'EE102139798',
      suggested_supplier: {
        id: 37,
        name: 'Citybee Eesti OÜ',
        country: 'EE',
        registration_key: 'EE102139798',
      },
    });
    // Lookup uses the NORMALIZED key.
    expect(calls).toEqual([['registration_key', 'EE102139798']]);
    // The stale AI-proposed entity id is absent from the read model.
    expect(JSON.stringify(result)).not.toContain('705731');
  });

  it('returns no suggestion when the observed key resolves to nothing', async () => {
    const proposal: SupplierProposal = {
      mode: 'match',
      match_entity_id: 705731,
      observed_country: 'EE',
      observed_registration_key: 'EE102139798',
    };
    const { resolver } = resolverReturning(undefined);

    const result = await buildPendingSupplierProposal(proposal, resolver);

    expect(result).toMatchObject({
      kind: 'invalid_match',
      observed_registration_key: 'EE102139798',
      suggested_supplier: null,
    });
  });

  it('rejects a match to a non-supplier entity as no suggestion', async () => {
    const proposal: SupplierProposal = {
      mode: 'match',
      match_entity_id: 705731,
      observed_country: 'EE',
      observed_registration_key: 'EE102139798',
    };
    const { resolver } = resolverReturning(supplier({ role: 'customer' }));

    const result = await buildPendingSupplierProposal(proposal, resolver);

    expect(result).toMatchObject({ suggested_supplier: null });
  });

  it('skips the lookup and yields no suggestion when no identifier was observed', async () => {
    const proposal: SupplierProposal = {
      mode: 'match',
      match_entity_id: 705731,
      observed_country: '  ',
      observed_registration_key: null,
    };
    const { resolver, calls } = resolverReturning(supplier());

    const result = await buildPendingSupplierProposal(proposal, resolver);

    expect(result).toEqual({
      kind: 'invalid_match',
      observed_country: null,
      observed_registration_key: null,
      suggested_supplier: null,
    });
    expect(calls).toHaveLength(0);
  });
});
