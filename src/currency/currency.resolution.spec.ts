import { Test, TestingModule } from '@nestjs/testing';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import SqliteDb from 'better-sqlite3';
import { Database } from '../database/types';
import { migrations } from '../database/migrations';
import { OrganizationService } from '../organization/organization.service';
import { NullCountryPlugin } from '../plugins/null-country.plugin';
import { PluginLoader } from '../plugins/plugin-loader.service';
import { CurrencyService } from './currency.service';

/**
 * Integration test for the base-currency resolution chain:
 *   CurrencyService -> OrganizationService (DB) + PluginLoader (country plugin)
 *
 * Exercises the REAL DI graph against an in-memory SQLite DB seeded by the
 * real migration. This is the test that would have caught the original bug
 * where CurrencyService returned a hardcoded constant disconnected from the
 * Organization.
 */
describe('Base currency resolution (integration)', () => {
  let db: Kysely<Database>;
  let currency: CurrencyService;
  let organization: OrganizationService;

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
        PluginLoader,
        CurrencyService,
      ],
    }).compile();

    currency = module.get(CurrencyService);
    organization = module.get(OrganizationService);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('resolves the seeded Irish org with no override to the plugin default (EUR)', async () => {
    await expect(currency.getBaseCurrency()).resolves.toBe('EUR');
  });

  it('uses an explicit override once set on the organization', async () => {
    await organization.updateOrganization({ base_currency: 'USD' });
    await expect(currency.getBaseCurrency()).resolves.toBe('USD');
  });

  it('falls back to the plugin default when the override is cleared', async () => {
    await organization.updateOrganization({ base_currency: 'USD' });
    await organization.updateOrganization({ base_currency: null });
    await expect(currency.getBaseCurrency()).resolves.toBe('EUR');
  });
});
