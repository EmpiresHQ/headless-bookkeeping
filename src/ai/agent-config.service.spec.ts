// src/ai/agent-config.service.spec.ts
import { Test, TestingModule } from '@nestjs/testing';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import SqliteDb from 'better-sqlite3';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import { Database } from '../database/types';
import { migrations } from '../database/migrations';
import { AgentConfigService } from './agent-config.service';
import { AGENT_PROMPTS, DEFAULT_MODEL } from './agent-config';

describe('AgentConfigService (integration)', () => {
  let db: Kysely<Database>;
  let config: AgentConfigService;

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
      throw error instanceof Error ? error : new Error('migrate failed');
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: KYSELY_MODULE_CONNECTION_TOKEN(), useValue: db },
        AgentConfigService,
      ],
    }).compile();
    config = module.get(AgentConfigService);
  });

  afterEach(async () => {
    await db.destroy();
  });

  const set = (key: string, value: string) =>
    db.insertInto('setting').values({ key, value, updated_at: 0 }).execute();

  it('falls back to DEFAULT_MODEL when no model setting exists', async () => {
    await expect(config.resolveModel('triage')).resolves.toBe(DEFAULT_MODEL);
  });

  it('uses the global ai_model when set', async () => {
    await set('ai_model', 'openai/gpt-4o');
    await expect(config.resolveModel('triage')).resolves.toBe('openai/gpt-4o');
  });

  it('prefers a per-agent override over the global model', async () => {
    await set('ai_model', 'openai/gpt-4o');
    await set('ai_model.intent_classifier', 'anthropic/claude-haiku');
    await expect(config.resolveModel('intent_classifier')).resolves.toBe(
      'anthropic/claude-haiku',
    );
    await expect(config.resolveModel('triage')).resolves.toBe('openai/gpt-4o');
  });

  it('falls back to the code default prompt when no prompt setting exists', async () => {
    await expect(config.resolveInstructions('triage')).resolves.toBe(
      AGENT_PROMPTS.triage,
    );
  });

  it('prefers a prompt.<key> override over the code default', async () => {
    await set('prompt.intent_classifier', 'CUSTOM PROMPT');
    await expect(config.resolveInstructions('intent_classifier')).resolves.toBe(
      'CUSTOM PROMPT',
    );
  });

  it('resolve() returns both model and instructions', async () => {
    await set('ai_model.triage', 'openai/gpt-4o');
    const resolved = await config.resolve('triage');
    expect(resolved).toEqual({
      model: 'openai/gpt-4o',
      instructions: AGENT_PROMPTS.triage,
    });
  });

  describe('resolveModelConfig', () => {
    it('returns the bare model string when no ai_base_url is set', async () => {
      await expect(config.resolveModelConfig('triage')).resolves.toBe(
        DEFAULT_MODEL,
      );
    });

    it('returns an OpenAI-compatible config object when ai_base_url + ai_api_key + ai_model are set', async () => {
      await set('ai_base_url', 'https://openrouter.ai/api/v1');
      await set('ai_api_key', 'sk-test');
      await set('ai_model', 'anthropic/claude-3-5');
      await expect(config.resolveModelConfig('triage')).resolves.toEqual({
        id: 'anthropic/claude-3-5',
        url: 'https://openrouter.ai/api/v1',
        apiKey: 'sk-test',
      });
    });

    it('returns a config object without apiKey when only ai_base_url is set', async () => {
      await set('ai_base_url', 'http://localhost:1234/v1');
      await expect(config.resolveModelConfig('triage')).resolves.toEqual({
        id: DEFAULT_MODEL,
        url: 'http://localhost:1234/v1',
      });
    });
  });
});
