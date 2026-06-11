import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import SqliteDb from 'better-sqlite3';
import { Database } from '../src/database/types';
import { migrations } from '../src/database/migrations';
import { AppModule } from '../src/app.module';
import { MastraService } from '../src/ai/mastra.service';
import { fauxMastraService } from './faux-mastra.service';
import { DOCUMENT_STORAGE_ROOT } from '../src/documents/document-storage.service';
import request from 'supertest';
import { App } from 'supertest/types';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * End-to-end test for the Telegram webhook flow:
 *   POST /api/channels/telegram/webhook → secret-token gate → router → Conversation persisted.
 *
 * Boots the full AppModule against an in-memory SQLite DB (seeded by real migrations).
 * @mastra/* is stubbed via test/jest-e2e.json moduleNameMapper; the stub's generate()
 * returns { object: undefined } so safeParse rejects → classifier degrades to clarify →
 * HttpTelegramApi (unset bot token) logs-and-drops. Webhook still returns { ok: true }.
 * The test asserts only the Conversation row — fully deterministic without a live Bot API.
 */
describe('Telegram webhook (e2e)', () => {
  let app: INestApplication<App>;
  let db: Kysely<Database>;
  let root: string;

  beforeAll(async () => {
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

    root = mkdtempSync(join(tmpdir(), 'interaction-e2e-'));

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(KYSELY_MODULE_CONNECTION_TOKEN())
      .useValue(db)
      .overrideProvider(DOCUMENT_STORAGE_ROOT)
      .useValue(root)
      .overrideProvider(MastraService)
      .useValue(fauxMastraService)
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();

    // Seed settings AFTER migrations have run.
    await db
      .insertInto('setting')
      .values({ key: 'telegram_webhook_secret', value: 'sek', updated_at: 0 })
      .execute();
    await db
      .insertInto('setting')
      .values({ key: 'telegram_allowlist', value: '999', updated_at: 0 })
      .execute();
    await db
      .insertInto('setting')
      .values({ key: 'approvers', value: '999', updated_at: 0 })
      .execute();
  });

  afterAll(async () => {
    await app.close();
    await db.destroy();
    rmSync(root, { recursive: true, force: true });
  });

  const update = {
    update_id: 1,
    message: {
      message_id: 5,
      chat: { id: 999 },
      from: { id: 999 },
      text: 'what is my VAT due?',
    },
  };

  it('403s a webhook with a wrong secret token', async () => {
    await request(app.getHttpServer())
      .post('/api/channels/telegram/webhook')
      .set('x-telegram-bot-api-secret-token', 'wrong')
      .send(update)
      .expect(403);
  });

  it('accepts a valid webhook and creates an open Conversation at thread_key=tg:999', async () => {
    await request(app.getHttpServer())
      .post('/api/channels/telegram/webhook')
      .set('x-telegram-bot-api-secret-token', 'sek')
      .send(update)
      .expect(200)
      .expect({ ok: true });

    const convo = await db
      .selectFrom('conversation')
      .selectAll()
      .where('thread_key', '=', 'tg:999')
      .executeTakeFirstOrThrow();
    expect(convo.status).toBe('open');
    expect(convo.channel).toBe('telegram');
  });
});
