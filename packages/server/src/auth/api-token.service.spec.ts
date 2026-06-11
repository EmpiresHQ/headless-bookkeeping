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
});
