import { Test, TestingModule } from '@nestjs/testing';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import SqliteDb from 'better-sqlite3';
import { Database } from '../database/types';
import { migrations } from '../database/migrations';
import { OrganizationService } from './organization.service';

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
});
