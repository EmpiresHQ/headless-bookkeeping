import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import SqliteDb from 'better-sqlite3';
import { Database } from '../types';
import { migrations } from './index';

describe('migration 058 — mailbox_connector', () => {
  let db: Kysely<Database>;

  beforeEach(async () => {
    db = new Kysely<Database>({
      dialect: new SqliteDialect({ database: new SqliteDb(':memory:') }),
    });
    const migrator = new Migrator({
      db,
      provider: { getMigrations: () => Promise.resolve(migrations) },
    });
    const { error } = await migrator.migrateToLatest();
    if (error) throw error;
  });

  afterEach(async () => db.destroy());

  it('inserts an email_sync connector with cursor defaults', async () => {
    const now = Math.floor(Date.now() / 1000);
    const row = await db
      .insertInto('mailbox_connector')
      .values({
        channel: 'email_sync',
        auth_mode: 'oauth',
        provider: 'gmail',
        host: 'imap.gmail.com',
        port: 993,
        username: 'me@gmail.com',
        secret_cipher: 'x',
        folder: 'INBOX',
        status: 'connected',
        created_at: now,
        updated_at: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    expect(row.last_uid).toBe(0);
    expect(row.uidvalidity).toBeNull();
    expect(row.status).toBe('connected');
  });

  it('enforces a single email_push connector', async () => {
    const now = Math.floor(Date.now() / 1000);
    const base = {
      auth_mode: 'password' as const,
      provider: 'imap' as const,
      host: 'h',
      port: 993,
      secret_cipher: 'x',
      folder: 'INBOX',
      status: 'connected' as const,
      created_at: now,
      updated_at: now,
    };
    await db
      .insertInto('mailbox_connector')
      .values({ ...base, channel: 'email_push', username: 'a@x' })
      .execute();
    await expect(
      db
        .insertInto('mailbox_connector')
        .values({ ...base, channel: 'email_push', username: 'b@x' })
        .execute(),
    ).rejects.toThrow();
  });
});
