/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */
import { Test, TestingModule } from '@nestjs/testing';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import SqliteDb from 'better-sqlite3';
import { Database } from '../database/types';
import { migrations } from '../database/migrations';
import { EntitiesService } from '../entities/entities.service';
import { ExpensesService } from '../expenses/expenses.service';
import { PluginLoader } from '../plugins/plugin-loader.service';
import { NullCountryPlugin } from '../plugins/null-country.plugin';
import { CurrencyService } from '../currency/currency.service';
import { OrganizationService } from '../organization/organization.service';
import { MastraService } from './mastra.service';

describe('MastraService', () => {
  let db: Kysely<Database>;
  let service: MastraService;

  // Mock classes for testing (avoid dynamic ESM imports in Jest).
  const MockMastra = jest
    .fn()
    .mockImplementation((config: Record<string, unknown>) => ({
      agents: config.agents,
      storage: config.storage,
    }));

  const MockAgent = jest
    .fn()
    .mockImplementation((config: Record<string, unknown>) => ({
      id: config.id,
      name: config.name,
      instructions: config.instructions,
      tools: config.tools,
      model: config.model,
    }));

  const MockLibSQLStore = jest
    .fn()
    .mockImplementation((config: Record<string, unknown>) => ({
      id: config.id,
      url: config.url,
    }));

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
        EntitiesService,
        ExpensesService,
        MastraService,
      ],
    }).compile();

    service = module.get(MastraService);

    // Initialize with mock classes instead of dynamic imports.
    await service.initialize({
      MastraClass: MockMastra,
      AgentClass: MockAgent,
      LibSQLStoreClass: MockLibSQLStore,
    });
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

    it('agent has no write tools (grep-clean: no post/createDraft/proposeDraft)', () => {
      const agent = service.getAgent();
      expect(agent).not.toBeNull();

      const agentAny = agent;
      const toolNames = Object.keys(agentAny.tools || {});
      const writeKeywords = ['post', 'createDraft', 'proposeDraft'];

      for (const name of toolNames) {
        for (const keyword of writeKeywords) {
          expect(name.toLowerCase()).not.toContain(keyword.toLowerCase());
        }
      }
    });

    it('agent has the expected read-only tools', () => {
      const agent = service.getAgent();

      const agentAny = agent;
      const toolNames = Object.keys(agentAny.tools || {});

      expect(toolNames).toContain('searchSuppliers');
      expect(toolNames).toContain('listCategories');
      expect(toolNames).toContain('getClassificationMemory');
      expect(toolNames).toContain('previewCategoryMapping');
      expect(toolNames).toHaveLength(4);
    });

    it('falls back to the default model when no setting row exists', () => {
      const agent = service.getAgent();
      expect(agent).not.toBeNull();
      expect(agent.model).toBe('openai/gpt-4o-mini');
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

      const freshMockAgent = jest
        .fn()
        .mockImplementation((config: Record<string, unknown>) => ({
          id: config.id,
          name: config.name,
          instructions: config.instructions,
          tools: config.tools,
          model: config.model,
        }));

      await service.initialize({
        MastraClass: MockMastra,
        AgentClass: freshMockAgent,
        LibSQLStoreClass: MockLibSQLStore,
      });

      const agent = service.getAgent();
      expect(agent).not.toBeNull();
      expect(agent.model).toBe('openai/gpt-4o');
    });
  });
});
