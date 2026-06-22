import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import SqliteDb from 'better-sqlite3';
import { Database } from '../database/types';
import { migrations } from '../database/migrations';
import { ApiTokenService } from './api-token.service';

describe('ApiTokenService (A1: token management over the service)', () => {
  let db: Kysely<Database>;
  let service: ApiTokenService;

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
      throw error instanceof Error ? error : new Error('Migration failed');

    service = new ApiTokenService(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('create returns a plaintext token that verifies', async () => {
    const { id, token } = await service.create('agent-1');
    expect(id).toBeGreaterThan(0);
    expect(token).toHaveLength(64);
    const verified = await service.verify(token);
    expect(verified?.id).toBe(id);
  });

  it('list returns tokens with metadata but never the hash or plaintext', async () => {
    await service.create('agent-1');
    await service.create('agent-2');

    const tokens = await service.list();
    expect(tokens).toHaveLength(2);
    expect(tokens.map((t) => t.label)).toEqual(
      expect.arrayContaining(['agent-1', 'agent-2']),
    );
    for (const t of tokens) {
      expect(t).toHaveProperty('id');
      expect(t).toHaveProperty('created_at');
      expect(t).toHaveProperty('revoked_at');
      expect(t).not.toHaveProperty('token_hash');
    }
  });

  it('revoked tokens no longer verify and are flagged in list', async () => {
    const { id, token } = await service.create('agent-1');
    await service.revoke(id);

    expect(await service.verify(token)).toBeNull();
    const row = (await service.list()).find((t) => t.id === id);
    expect(row?.revoked_at).not.toBeNull();
  });

  describe('verify — kind + lifecycle', () => {
    it('returns the kind for a static token', async () => {
      const { token } = await service.create('s');
      const row = await service.verify(token);
      expect(row?.kind).toBe('static');
    });

    it('rejects an expired enrollment token', async () => {
      const plaintext = 'expired-enroll';
      const hash = require('crypto')
        .createHash('sha256')
        .update(plaintext)
        .digest('hex');
      await db
        .insertInto('api_token')
        .values({
          token_hash: hash,
          label: 'e',
          kind: 'enrollment',
          expires_at: Math.floor(Date.now() / 1000) - 10,
        })
        .execute();
      expect(await service.verify(plaintext)).toBeNull();
    });

    it('rejects a consumed enrollment token', async () => {
      const plaintext = 'used-enroll';
      const hash = require('crypto')
        .createHash('sha256')
        .update(plaintext)
        .digest('hex');
      await db
        .insertInto('api_token')
        .values({
          token_hash: hash,
          label: 'e',
          kind: 'enrollment',
          expires_at: Math.floor(Date.now() / 1000) + 600,
          consumed_at: Math.floor(Date.now() / 1000),
        })
        .execute();
      expect(await service.verify(plaintext)).toBeNull();
    });
  });

  describe('create + createEnrollment', () => {
    it('mints a session token when kind is session', async () => {
      const { id } = await service.create('iPhone', 'session');
      const row = await db
        .selectFrom('api_token')
        .select(['kind', 'label'])
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
      expect(row.kind).toBe('session');
      expect(row.label).toBe('iPhone');
    });

    it('createEnrollment sets kind=enrollment and a future expiry', async () => {
      const before = Math.floor(Date.now() / 1000);
      const { id, token, expiresAt } = await service.createEnrollment(600);
      expect(token).toHaveLength(64);
      expect(expiresAt).toBeGreaterThanOrEqual(before + 600);
      const row = await db
        .selectFrom('api_token')
        .select(['kind', 'expires_at'])
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
      expect(row.kind).toBe('enrollment');
      expect(row.expires_at).toBe(expiresAt);
    });
  });
});
