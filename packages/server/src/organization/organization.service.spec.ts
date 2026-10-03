import { Test, TestingModule } from '@nestjs/testing';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import SqliteDb from 'better-sqlite3';
import { Database } from '../database/types';
import { migrations } from '../database/migrations';
import { OrganizationService } from './organization.service';
import { PluginLoader } from '../plugins/plugin-loader.service';
import { NullCountryPlugin } from '../plugins/null-country.plugin';
import { EstoniaCountryPlugin } from '../plugins/estonia-country.plugin';
import { fxTestProviders } from '../../test/fx-fixtures';

describe('OrganizationService (integration)', () => {
  let db: Kysely<Database>;
  let service: OrganizationService;

  beforeEach(async () => {
    const rawDb = new SqliteDb(':memory:');
    rawDb.pragma('foreign_keys = ON');
    db = new Kysely<Database>({
      dialect: new SqliteDialect({ database: rawDb }),
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
        NullCountryPlugin,
        EstoniaCountryPlugin,
        ...fxTestProviders(),
        PluginLoader,
        OrganizationService,
      ],
    }).compile();

    service = module.get(OrganizationService);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('persists and returns the organization IBAN', async () => {
    const updated = await service.updateOrganization({
      iban: 'EE382200221020145685',
    });
    expect(updated.iban).toBe('EE382200221020145685');

    const fetched = await service.getOrganization();
    expect(fetched.iban).toBe('EE382200221020145685');
  });
  it('keeps the commercial registry code separate from the VAT number', async () => {
    expect((await service.getOrganization()).registry_code).toBeNull();
    await service.updateOrganization({
      registry_code: '17499653',
      vat_registration_number: 'EE102983355',
    });
    expect(await service.getOrganization()).toMatchObject({
      registry_code: '17499653',
      vat_registration_number: 'EE102983355',
    });
    await service.updateOrganization({ name: 'Updated company' });
    expect((await service.getOrganization()).registry_code).toBe('17499653');
    await service.updateOrganization({ registry_code: null });
    expect((await service.getOrganization()).registry_code).toBeNull();
    expect((await service.getOrganization()).vat_registration_number).toBe(
      'EE102983355',
    );
  });
});
