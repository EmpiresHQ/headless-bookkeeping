import { Test, TestingModule } from '@nestjs/testing';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import SqliteDb from 'better-sqlite3';
import { Database } from '../database/types';
import { migrations } from '../database/migrations';
import { OrganizationService } from './organization.service';
import { NullCountryPlugin } from '../plugins/null-country.plugin';
import { EstoniaCountryPlugin } from '../plugins/estonia-country.plugin';
import { PluginLoader } from '../plugins/plugin-loader.service';
import { OrgContextResolver } from './org-context.resolver';

/**
 * Real-DI integration test for OrgContextResolver (G2 gate).
 *
 * The resolver concentrates the resolve-plugin + build-OrgContext ceremony that
 * six services hand-built. It seeds a real org via migrations + OrganizationService,
 * then asserts resolve() returns the org, the country-resolved plugin, and the
 * exact OrgContext shape (country / vatRegistered / baseCurrency).
 */
describe('OrgContextResolver (integration)', () => {
  let db: Kysely<Database>;
  let resolver: OrgContextResolver;
  let organizationService: OrganizationService;
  let nullPlugin: NullCountryPlugin;
  let estoniaPlugin: EstoniaCountryPlugin;

  beforeEach(async () => {
    db = new Kysely<Database>({
      dialect: new SqliteDialect({ database: new SqliteDb(':memory:') }),
    });

    const migrator = new Migrator({
      db,
      provider: { getMigrations: () => Promise.resolve(migrations) },
    });
    const { error } = await migrator.migrateToLatest();
    if (error)
      throw error instanceof Error ? error : new Error('Migration failed');

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: KYSELY_MODULE_CONNECTION_TOKEN(), useValue: db },
        OrganizationService,
        NullCountryPlugin,
        EstoniaCountryPlugin,
        PluginLoader,
        OrgContextResolver,
      ],
    }).compile();

    resolver = module.get(OrgContextResolver);
    organizationService = module.get(OrganizationService);
    nullPlugin = module.get(NullCountryPlugin);
    estoniaPlugin = module.get(EstoniaCountryPlugin);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('returns the organization unchanged', async () => {
    const { organization } = await resolver.resolve();
    const direct = await organizationService.getOrganization();
    expect(organization).toEqual(direct);
  });

  it('resolves the EE plugin when country = "EE"', async () => {
    await organizationService.updateOrganization({ country: 'EE' });

    const { plugin } = await resolver.resolve();

    expect(plugin).toBe(estoniaPlugin);
  });

  it('falls back to the null plugin for the default (IE) org', async () => {
    const { plugin } = await resolver.resolve();

    expect(plugin).toBe(nullPlugin);
  });

  it('builds the exact OrgContext shape for the default (IE) org', async () => {
    const { orgContext } = await resolver.resolve();

    expect(orgContext).toEqual({
      country: 'IE',
      vatRegistered: false,
      baseCurrency: null,
    });
  });

  it('reflects an updated org in the OrgContext (EE, VAT-registered, EUR override)', async () => {
    await organizationService.updateOrganization({
      country: 'EE',
      vat_registered: true,
      base_currency: 'EUR',
    });

    const { plugin, orgContext } = await resolver.resolve();

    expect(plugin).toBe(estoniaPlugin);
    expect(orgContext).toEqual({
      country: 'EE',
      vatRegistered: true,
      baseCurrency: 'EUR',
    });
  });
});
