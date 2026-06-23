import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import SqliteDb from 'better-sqlite3';
import { Test } from '@nestjs/testing';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import { Database } from '../database/types';
import { migrations } from '../database/migrations';
import { MailboxConnectorService } from './mailbox-connector.service';

const KEY = '0'.repeat(64);

describe('MailboxConnectorService', () => {
  let db: Kysely<Database>;
  let service: MailboxConnectorService;

  beforeEach(async () => {
    process.env.MAILBOX_SECRET_KEY = KEY;
    db = new Kysely<Database>({ dialect: new SqliteDialect({ database: new SqliteDb(':memory:') }) });
    const migrator = new Migrator({ db, provider: { getMigrations: () => Promise.resolve(migrations) } });
    const { error } = await migrator.migrateToLatest();
    if (error) throw error;
    const moduleRef = await Test.createTestingModule({
      providers: [{ provide: KYSELY_MODULE_CONNECTION_TOKEN(), useValue: db }, MailboxConnectorService],
    }).compile();
    service = moduleRef.get(MailboxConnectorService);
  });
  afterEach(() => db.destroy());

  const input = {
    channel: 'email_sync' as const, authMode: 'password' as const, provider: 'imap' as const,
    host: 'imap.x', port: 993, username: 'me@x', secret: 'app-pass', folder: 'INBOX',
  };

  it('creates a connector and never returns the secret', async () => {
    const c = await service.create(input);
    expect(c).not.toHaveProperty('secret_cipher');
    expect(c).not.toHaveProperty('secret');
    expect(await service.getDecryptedSecret(c.id)).toBe('app-pass');
  });

  it('rejects a second email_push connector', async () => {
    await service.create({ ...input, channel: 'email_push' });
    await expect(service.create({ ...input, channel: 'email_push', username: 'b@x' })).rejects.toThrow();
  });

  it('advances the cursor and marks status', async () => {
    const c = await service.create(input);
    await service.advanceCursor(c.id, 42, 17);
    await service.markStatus(c.id, 'auth_failed', 'token revoked');
    const [row] = await service.list();
    expect(row.uidvalidity).toBe(42);
    expect(row.last_uid).toBe(17);
    expect(row.status).toBe('auth_failed');
    expect(row.last_error).toBe('token revoked');
  });
});
