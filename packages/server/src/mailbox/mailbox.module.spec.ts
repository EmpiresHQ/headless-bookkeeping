/**
 * DI-resolution smoke test for MailboxModule.
 *
 * We override the Kysely DB connection with an in-memory SQLite instance
 * (same pattern as mailbox-connector.service.spec.ts and mail-sync.worker.spec.ts)
 * so the full NestJS DI graph can be compiled without hitting a real database
 * or requiring env-based config.  The test proves every provider declared in
 * MailboxModule (and its imported upstream modules) resolves correctly.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import SqliteDb from 'better-sqlite3';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import { Database } from '../database/types';
import { migrations } from '../database/migrations';
import { MailboxModule } from './mailbox.module';
import { MailboxController } from './mailbox.controller';
import { MailSyncWorker } from './mail-sync.worker';

describe('MailboxModule DI resolution', () => {
  let db: Kysely<Database>;
  let moduleRef: TestingModule;

  beforeAll(async () => {
    process.env.MAILBOX_SECRET_KEY = '0'.repeat(64);

    db = new Kysely<Database>({
      dialect: new SqliteDialect({ database: new SqliteDb(':memory:') }),
    });
    const migrator = new Migrator({
      db,
      provider: { getMigrations: () => Promise.resolve(migrations) },
    });
    const { error } = await migrator.migrateToLatest();
    if (error) throw error;

    moduleRef = await Test.createTestingModule({
      imports: [MailboxModule],
    })
      .overrideProvider(KYSELY_MODULE_CONNECTION_TOKEN())
      .useValue(db)
      .compile();
  });

  afterAll(async () => {
    await moduleRef?.close();
    await db?.destroy();
  });

  it('resolves MailboxController', () => {
    const ctrl = moduleRef.get(MailboxController);
    expect(ctrl).toBeDefined();
  });

  it('resolves MailSyncWorker', () => {
    const worker = moduleRef.get(MailSyncWorker);
    expect(worker).toBeDefined();
  });
});
