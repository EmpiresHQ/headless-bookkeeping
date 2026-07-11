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
import { EstoniaCountryPlugin } from '../plugins/estonia-country.plugin';
import { CurrencyService } from '../currency/currency.service';
import { OrganizationService } from '../organization/organization.service';
import { OrgContextResolver } from '../organization/org-context.resolver';
import { AgentConfigService } from './agent-config.service';
import { CategoryService } from '../categories/category.service';
import { MastraService } from './mastra.service';
import { PeriodLockService } from '../reporting-periods/period-lock.service';

const EXPECTED_TRIAGE_TOOL_NAMES = [
  'searchSuppliers',
  'listCategories',
  'getClassificationMemory',
  'previewCategoryMapping',
  'getClassificationContext',
] as const;

const EXPECTED_ENRICHMENT_TOOL_NAMES = [
  'listCategories',
  'getClassificationMemory',
  'previewCategoryMapping',
  'getClassificationContext',
] as const;

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
        EstoniaCountryPlugin,
        PluginLoader,
        OrgContextResolver,
        CurrencyService,
        VoucherProjectionService,
        EntitiesService,
        ExpensesService,
        {
          provide: PeriodLockService,
          useValue: {
            assertPeriodOpen: jest.fn().mockResolvedValue(undefined),
            findLockedPeriod: jest.fn().mockResolvedValue(undefined),
            getCurrentOpenPeriod: jest.fn().mockResolvedValue(undefined),
          },
        },
        AgentConfigService,
        CategoryService,
        MastraService,
      ],
    }).compile();

    service = module.get(MastraService);

    // Agents are built on demand via buildTriageAgent()/buildBankMappingAgent().
    // Those statically import @mastra/*; under Jest the specifiers map to
    // test/mastra-stub.ts (see moduleNameMapper), so the real Agent API is
    // exercised against the stub classes. Each build re-reads the settings table.
  });

  afterEach(async () => {
    await db.destroy();
  });

  describe('buildTriageAgent', () => {
    it('resolves in DI and builds a triage agent on demand', async () => {
      expect(service).toBeDefined();
      expect(await service.buildTriageAgent()).not.toBeNull();
    });

    it('agent has no write tools (grep-clean: no post/createDraft/proposeDraft)', async () => {
      const agent = await service.buildTriageAgent();

      const toolNames = Object.keys((await agent.listTools()) ?? {});
      const writeKeywords = ['post', 'createDraft', 'proposeDraft'];

      for (const name of toolNames) {
        for (const keyword of writeKeywords) {
          expect(name.toLowerCase()).not.toContain(keyword.toLowerCase());
        }
      }
    });

    it('agent has the expected read-only tools', async () => {
      const agent = await service.buildTriageAgent();

      const toolNames = Object.keys((await agent.listTools()) ?? {});

      expect(toolNames).toEqual(
        expect.arrayContaining(EXPECTED_TRIAGE_TOOL_NAMES),
      );
      expect(toolNames).toHaveLength(EXPECTED_TRIAGE_TOOL_NAMES.length);
    });

    it('falls back to the default model when no setting row exists', async () => {
      const agent = await service.buildTriageAgent();
      expect(agent.model).toBe('openai/gpt-4o-mini');
    });

    it('reads the model from the settings table on each build', async () => {
      await db
        .insertInto('setting')
        .values({
          key: 'ai_model',
          value: 'openai/gpt-4o',
          updated_at: Math.floor(Date.now() / 1000),
        })
        .execute();

      // No re-initialization step: the next build simply re-reads settings.
      const agent = await service.buildTriageAgent();
      expect(agent.model).toBe('openai/gpt-4o');
    });

    it('resolves model and instructions from AgentConfigService (per-agent override)', async () => {
      await db
        .insertInto('setting')
        .values([
          { key: 'ai_model.triage', value: 'openai/gpt-4o', updated_at: 0 },
          {
            key: 'prompt.triage',
            value: 'SEEDED TRIAGE PROMPT',
            updated_at: 0,
          },
        ])
        .execute();

      const agent = await service.buildTriageAgent();
      expect(agent.model).toBe('openai/gpt-4o');
      // withCategoryList appends the valid category keys from the active plugin;
      // the seeded prompt is retained as the leading prefix.
      expect(await agent.getInstructions()).toContain('SEEDED TRIAGE PROMPT');
    });
  });

  describe('buildBankMappingAgent', () => {
    it('builds a tool-less bank-mapping agent from settings', async () => {
      const agent = await service.buildBankMappingAgent();

      expect(agent.model).toBe('openai/gpt-4o-mini');
      expect(Object.keys((await agent.listTools()) ?? {})).toHaveLength(0);
    });
  });

  describe('buildTriageEnrichmentAgent', () => {
    it('builds a read-only enrichment agent led by getClassificationContext', async () => {
      const buildEnrichmentAgent = Reflect.get(
        service,
        'buildTriageEnrichmentAgent',
      );

      expect(typeof buildEnrichmentAgent).toBe('function');

      const agent = await buildEnrichmentAgent.call(service);
      const toolNames = Object.keys((await agent.listTools()) ?? {});

      expect(toolNames).toEqual(
        expect.arrayContaining(EXPECTED_ENRICHMENT_TOOL_NAMES),
      );
      expect(toolNames).toHaveLength(EXPECTED_ENRICHMENT_TOOL_NAMES.length);
      expect(toolNames).not.toContain('searchSuppliers');
      expect(toolNames).toContain('getClassificationContext');
    });
  });

  describe('buildTriageClassificationAgent', () => {
    it('builds a strict classification agent with no tools', async () => {
      const buildClassificationAgent = Reflect.get(
        service,
        'buildTriageClassificationAgent',
      );

      expect(typeof buildClassificationAgent).toBe('function');

      const agent = await buildClassificationAgent.call(service);

      expect(Object.keys((await agent.listTools()) ?? {})).toHaveLength(0);
    });
  });
});
