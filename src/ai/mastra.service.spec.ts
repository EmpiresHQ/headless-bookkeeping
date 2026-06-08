import { Test, TestingModule } from '@nestjs/testing';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import SqliteDb from 'better-sqlite3';
import { Database } from '../database/types';
import { migrations } from '../database/migrations';
import { EntitiesService } from '../entities/entities.service';
import { ExpensesService } from '../expenses/expenses.service';
import { VoucherProjectionService } from '../ledger/projection/voucher-projection.service';
import { PluginLoader } from '../plugins/plugin-loader.service';
import { NullCountryPlugin } from '../plugins/null-country.plugin';
import { CurrencyService } from '../currency/currency.service';
import { OrganizationService } from '../organization/organization.service';
import { MastraService } from './mastra.service';

describe('MastraService', () => {
  let db: Kysely<Database>;
  let service: MastraService;

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
        NullCountryPlugin,
        PluginLoader,
        CurrencyService,
        VoucherProjectionService,
        EntitiesService,
        ExpensesService,
        MastraService,
      ],
    }).compile();

    service = module.get(MastraService);

    // initialize() statically imports @mastra/*; under Jest those specifiers
    // are mapped to test/mastra-stub.ts (see moduleNameMapper), so the real
    // API is exercised against the stub classes.
    await service.initialize();
  });

  afterEach(async () => {
    await db.destroy();
  });

  describe('initialization', () => {
    it('resolves in DI and initializes Mastra + agent', () => {
      expect(service).toBeDefined();
      expect(service.isInitialized()).toBe(true);
      expect(service.getMastra()).not.toBeNull();
      expect(service.getAgent()).not.toBeNull();
    });

    it('agent has no write tools (grep-clean: no post/createDraft/proposeDraft)', async () => {
      const agent = service.getAgent();
      expect(agent).not.toBeNull();

      const toolNames = Object.keys((await agent?.listTools()) ?? {});
      const writeKeywords = ['post', 'createDraft', 'proposeDraft'];

      for (const name of toolNames) {
        for (const keyword of writeKeywords) {
          expect(name.toLowerCase()).not.toContain(keyword.toLowerCase());
        }
      }
    });

    it('agent has the expected read-only tools', async () => {
      const agent = service.getAgent();

      const toolNames = Object.keys((await agent?.listTools()) ?? {});

      expect(toolNames).toContain('searchSuppliers');
      expect(toolNames).toContain('listCategories');
      expect(toolNames).toContain('getClassificationMemory');
      expect(toolNames).toContain('previewCategoryMapping');
      // The composed deep read is the primary path (granular tools retained).
      expect(toolNames).toContain('getClassificationContext');
      expect(toolNames).toHaveLength(5);
    });

    it('falls back to the default model when no setting row exists', () => {
      const agent = service.getAgent();
      expect(agent).not.toBeNull();
      expect(agent?.model).toBe('openai/gpt-4o-mini');
    });

    it('reads the model from the settings table', async () => {
      await db
        .insertInto('setting')
        .values({
          key: 'ai_model',
          value: 'openai/gpt-4o',
          updated_at: Math.floor(Date.now() / 1000),
        })
        .execute();

      await service.initialize();

      const agent = service.getAgent();
      expect(agent).not.toBeNull();
      expect(agent?.model).toBe('openai/gpt-4o');
    });
  });
});
