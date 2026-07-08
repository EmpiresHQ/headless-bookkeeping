// src/interaction/config/interaction-config.service.spec.ts
import { Test, TestingModule } from '@nestjs/testing';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import SqliteDb from 'better-sqlite3';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import { Database } from '../../database/types';
import { migrations } from '../../database/migrations';
import { InteractionConfigService } from './interaction-config.service';

describe('InteractionConfigService (integration)', () => {
  let db: Kysely<Database>;
  let config: InteractionConfigService;

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
        InteractionConfigService,
      ],
    }).compile();
    config = module.get(InteractionConfigService);
  });

  afterEach(async () => {
    await db.destroy();
  });

  async function setSetting(key: string, value: string): Promise<void> {
    await db
      .insertInto('setting')
      .values({ key, value, updated_at: 0 })
      .execute();
  }

  it('defaults ingest_policy to known-only when unset', async () => {
    await expect(config.getIngestPolicy()).resolves.toBe('known-only');
  });

  it('reads a configured ingest_policy', async () => {
    await setSetting('ingest_policy', 'quarantine');
    await expect(config.getIngestPolicy()).resolves.toBe('quarantine');
  });

  it('parses the telegram_allowlist as a comma-separated id set', async () => {
    await setSetting('telegram_allowlist', '111, 222 ,333');
    const ids = await config.getTelegramAllowlist();
    expect(ids).toEqual(new Set(['111', '222', '333']));
  });

  it('returns an empty approver set when unset', async () => {
    await expect(config.getApprovers()).resolves.toEqual(new Set());
  });

  it('reads the telegram webhook secret', async () => {
    await setSetting('telegram_webhook_secret', 's3cr3t');
    await expect(config.getTelegramWebhookSecret()).resolves.toBe('s3cr3t');
  });

  it('returns null for public_api_url when unset', async () => {
    await expect(config.getPublicApiUrl()).resolves.toBeNull();
  });

  it('reads public_api_url without rewriting it', async () => {
    await setSetting('public_api_url', 'https://app.example/');
    await expect(config.getPublicApiUrl()).resolves.toBe(
      'https://app.example/',
    );
  });
});
