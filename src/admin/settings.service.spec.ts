import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import SqliteDb from 'better-sqlite3';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import { Database } from '../database/types';
import { migrations } from '../database/migrations';
import { SettingsService } from './settings.service';

describe('SettingsService (integration)', () => {
  let db: Kysely<Database>;
  let settings: SettingsService;

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
        SettingsService,
      ],
    }).compile();
    settings = module.get(SettingsService);
  });
  afterEach(async () => {
    await db.destroy();
  });

  it('upserts a known key and reads it back', async () => {
    await settings.set('ai_model', 'openai/gpt-4o');
    await expect(settings.get('ai_model')).resolves.toBe('openai/gpt-4o');
  });

  it('upsert overwrites (not duplicates) an existing key', async () => {
    await settings.set('ai_model', 'a');
    await settings.set('ai_model', 'b');
    await expect(settings.get('ai_model')).resolves.toBe('b');
    const rows = await db
      .selectFrom('setting')
      .selectAll()
      .where('key', '=', 'ai_model')
      .execute();
    expect(rows).toHaveLength(1);
  });

  it('rejects an unknown key', async () => {
    await expect(settings.set('not_a_key', 'x')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('rejects an invalid value for a known enum key', async () => {
    await expect(
      settings.set('ingest_policy', 'banana'),
    ).rejects.toBeInstanceOf(BadRequestException);
    await settings.set('ingest_policy', 'quarantine');
    await expect(settings.get('ingest_policy')).resolves.toBe('quarantine');
  });

  it('list returns all stored settings; delete removes one', async () => {
    await settings.set('ai_model', 'm');
    await settings.set('ingest_policy', 'open');
    const all = await settings.list();
    expect(all).toEqual(
      expect.arrayContaining([
        { key: 'ai_model', value: 'm' },
        { key: 'ingest_policy', value: 'open' },
      ]),
    );
    await settings.delete('ai_model');
    await expect(settings.get('ai_model')).resolves.toBeNull();
  });
});
