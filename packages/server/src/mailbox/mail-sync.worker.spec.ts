import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import SqliteDb from 'better-sqlite3';
import { Database } from '../database/types';
import { migrations } from '../database/migrations';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import { Test } from '@nestjs/testing';
import { MailboxConnectorService } from './mailbox-connector.service';
import { MailSyncWorker } from './mail-sync.worker';
import { ImapClient } from './imap-client.port';
import { SettingsService } from '../admin/settings.service';

const KEY = '0'.repeat(64);

describe('MailSyncWorker.syncOnce', () => {
  let db: Kysely<Database>;
  let connectors: MailboxConnectorService;
  let worker: MailSyncWorker;
  let imap: { fetchSince: jest.Mock; getLatestUid: jest.Mock; idle: jest.Mock };
  let harvested: number[];

  beforeEach(async () => {
    process.env.MAILBOX_SECRET_KEY = KEY;
    db = new Kysely<Database>({
      dialect: new SqliteDialect({ database: new SqliteDb(':memory:') }),
    });
    const migrator = new Migrator({
      db,
      provider: { getMigrations: () => Promise.resolve(migrations) },
    });
    const { error } = await migrator.migrateToLatest();
    if (error) throw error;
    harvested = [];
    imap = {
      fetchSince: jest.fn(),
      getLatestUid: jest.fn(async () => ({ uidvalidity: 1, latestUid: 0 })),
      idle: jest.fn(),
    };
    const harvest = {
      harvestMessage: jest.fn(async (_ch: string, m: { uid: number }) => {
        harvested.push(m.uid);
        return 1;
      }),
    };
    const oauth = { accessToken: jest.fn(async () => 'at') };
    const moduleRef = await Test.createTestingModule({
      providers: [
        { provide: KYSELY_MODULE_CONNECTION_TOKEN(), useValue: db },
        MailboxConnectorService,
        { provide: ImapClient, useValue: imap },
        { provide: 'HARVEST', useValue: harvest },
        { provide: 'OAUTH', useValue: oauth },
        { provide: SettingsService, useValue: { get: jest.fn(async () => null) } },
        MailSyncWorker,
      ],
    }).compile();
    connectors = moduleRef.get(MailboxConnectorService);
    worker = moduleRef.get(MailSyncWorker);
  });
  afterEach(() => db.destroy());

  const mk = () =>
    connectors.create({
      channel: 'email_sync',
      authMode: 'password',
      provider: 'imap',
      host: 'h',
      port: 993,
      username: 'u',
      secret: 'p',
    });

  it('harvests new messages in order and advances the cursor', async () => {
    const c = await mk();
    // Advance past baseline so syncOnce takes the incremental path (last_uid > 0).
    await connectors.advanceCursor(c.id, 100, 3);
    imap.fetchSince.mockResolvedValue({
      uidvalidity: 100,
      messages: [
        { uid: 4, subject: '', bodyText: '', attachments: [] },
        { uid: 5, subject: '', bodyText: '', attachments: [] },
      ],
    });
    await worker.syncOnce(c.id);
    expect(harvested).toEqual([4, 5]);
    const [row] = await connectors.list();
    expect(row.uidvalidity).toBe(100);
    expect(row.last_uid).toBe(5);
    expect(row.status).toBe('connected');
  });

  it('does not block startup on a hanging mailbox (onModuleInit fire-and-forgets IMAP)', async () => {
    await mk();
    // getLatestUid never resolves — simulates a slow/unreachable IMAP server at boot time.
    imap.getLatestUid.mockReturnValue(new Promise<never>(() => {}));
    // onModuleInit must resolve promptly instead of awaiting the hung sync,
    // otherwise NestJS bootstrap stalls and the HTTP listener never binds.
    await expect(worker.onModuleInit()).resolves.toBeUndefined();
  });

  it('re-baselines (no harvest) when uidvalidity changes', async () => {
    const c = await mk();
    await connectors.advanceCursor(c.id, 100, 5);
    imap.fetchSince.mockResolvedValue({
      uidvalidity: 999,
      messages: [{ uid: 1, subject: '', bodyText: '', attachments: [] }],
    });
    await worker.syncOnce(c.id);
    expect(harvested).toEqual([]); // history not re-harvested
    const [row] = await connectors.list();
    expect(row.uidvalidity).toBe(999);
    expect(row.last_uid).toBe(1); // cursor rebased to current max
  });

  it('marks auth_failed when the transport throws an auth error', async () => {
    const c = await mk();
    // Advance past baseline so error comes from fetchSince (incremental path).
    await connectors.advanceCursor(c.id, 100, 3);
    imap.fetchSince.mockRejectedValue(
      new Error('AUTHENTICATIONFAILED bad token'),
    );
    await worker.syncOnce(c.id);
    const [row] = await connectors.list();
    expect(row.status).toBe('auth_failed');
    expect(row.last_error).toContain('AUTHENTICATION');
  });

  it('retries a transient connect failure 5× with backoff, then marks the connector error', async () => {
    const c = await mk();
    // Advance past baseline so retries come from fetchSince (incremental path).
    await connectors.advanceCursor(c.id, 100, 3);
    imap.fetchSince.mockRejectedValue(new Error('ECONNREFUSED'));
    const delaySpy = jest
      .spyOn(worker as unknown as { delay(ms: number): Promise<void> }, 'delay')
      .mockResolvedValue(undefined); // no real backoff waits in the test
    await worker.syncOnce(c.id);
    expect(imap.fetchSince).toHaveBeenCalledTimes(5);
    expect(delaySpy).toHaveBeenCalledTimes(4); // backoff between the 5 attempts
    const [row] = await connectors.list();
    expect(row.status).toBe('error');
    expect(row.last_error).toContain('ECONNREFUSED');
  });

  it('does not retry an auth failure — fails fast to auth_failed', async () => {
    const c = await mk();
    // Advance past baseline so error comes from fetchSince (incremental path).
    await connectors.advanceCursor(c.id, 100, 3);
    imap.fetchSince.mockRejectedValue(
      new Error('AUTHENTICATIONFAILED bad token'),
    );
    const delaySpy = jest
      .spyOn(worker as unknown as { delay(ms: number): Promise<void> }, 'delay')
      .mockResolvedValue(undefined);
    await worker.syncOnce(c.id);
    expect(imap.fetchSince).toHaveBeenCalledTimes(1); // no retries
    expect(delaySpy).not.toHaveBeenCalled();
    const [row] = await connectors.list();
    expect(row.status).toBe('auth_failed');
  });

  it('keeps prior last_uid when uidvalidity changes but messages is empty', async () => {
    const c = await mk();
    await connectors.advanceCursor(c.id, 100, 5);
    imap.fetchSince.mockResolvedValue({ uidvalidity: 999, messages: [] });
    await worker.syncOnce(c.id);
    expect(harvested).toEqual([]);
    const [row] = await connectors.list();
    expect(row.uidvalidity).toBe(999);
    expect(row.last_uid).toBe(5); // NOT 0 — avoids full-folder re-fetch on next sync
  });

  describe('onModuleInit key fail-fast', () => {
    const VALID_KEY = '0'.repeat(64);

    afterEach(() => {
      process.env.MAILBOX_SECRET_KEY = VALID_KEY;
    });

    it('marks all connectors auth_failed and skips sync when key is missing', async () => {
      await mk();
      delete process.env.MAILBOX_SECRET_KEY;
      await worker.onModuleInit();
      expect(imap.fetchSince).not.toHaveBeenCalled();
      const [row] = await connectors.list();
      expect(row.status).toBe('auth_failed');
      expect(row.last_error).toContain('MAILBOX_SECRET_KEY missing or invalid');
    });

    it('marks all connectors auth_failed and skips sync when key is wrong length', async () => {
      await mk();
      process.env.MAILBOX_SECRET_KEY = 'bad';
      await worker.onModuleInit();
      expect(imap.fetchSince).not.toHaveBeenCalled();
      const [row] = await connectors.list();
      expect(row.status).toBe('auth_failed');
    });

    it('does nothing when there are no connectors and key is missing (keyless boot)', async () => {
      delete process.env.MAILBOX_SECRET_KEY;
      // no connectors created — should complete silently
      await expect(worker.onModuleInit()).resolves.toBeUndefined();
      expect(imap.fetchSince).not.toHaveBeenCalled();
    });
  });
});
