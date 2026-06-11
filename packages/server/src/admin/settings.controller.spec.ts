import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import SqliteDb from 'better-sqlite3';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import { Database } from '../database/types';
import { migrations } from '../database/migrations';
import { SettingsService } from './settings.service';
import { SettingsController } from './settings.controller';

describe('SettingsController (real-DI)', () => {
  let db: Kysely<Database>;
  let controller: SettingsController;

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
      controllers: [SettingsController],
      providers: [
        { provide: KYSELY_MODULE_CONNECTION_TOKEN(), useValue: db },
        SettingsService,
      ],
    }).compile();

    controller = module.get<SettingsController>(SettingsController);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('PUT upserts a known key; GET reads it', async () => {
    await controller.put('ai_model', { value: 'openai/gpt-4o' });
    await expect(controller.get('ai_model')).resolves.toEqual({
      key: 'ai_model',
      value: 'openai/gpt-4o',
    });
  });

  it('GET list returns stored settings', async () => {
    await controller.put('ingest_policy', { value: 'open' });
    const res = await controller.list();
    expect(res.settings).toEqual(
      expect.arrayContaining([{ key: 'ingest_policy', value: 'open' }]),
    );
  });

  it('PUT a bad value 400s', async () => {
    await expect(
      controller.put('ingest_policy', { value: 'nope' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('DELETE removes a key', async () => {
    await controller.put('ai_model', { value: 'm' });
    await controller.delete('ai_model');
    await expect(controller.get('ai_model')).resolves.toEqual({
      key: 'ai_model',
      value: null,
    });
  });
});
