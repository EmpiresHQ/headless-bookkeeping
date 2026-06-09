import { Test, TestingModule } from '@nestjs/testing';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import SqliteDb from 'better-sqlite3';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import { Database } from '../database/types';
import { migrations } from '../database/migrations';
import { ApiTokenService } from './api-token.service';

describe('ApiTokenService (integration)', () => {
  let db: Kysely<Database>;
  let service: ApiTokenService;

  beforeEach(async () => {
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

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: KYSELY_MODULE_CONNECTION_TOKEN(), useValue: db },
        ApiTokenService,
      ],
    }).compile();

    service = module.get(ApiTokenService);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('create returns a plaintext token and numeric id', async () => {
    const result = await service.create('test-label');
    expect(typeof result.token).toBe('string');
    expect(result.token).toHaveLength(64);
    expect(result.id).toBeGreaterThan(0);
  });

  it('verify returns the row for a valid token', async () => {
    const created = await service.create('verify-test');
    const row = await service.verify(created.token);
    expect(row).not.toBeNull();
    expect(row?.id).toBe(created.id);
    expect(row?.label).toBe('verify-test');
  });

  it('verify returns null for an invalid token', async () => {
    const row = await service.verify('deadbeef'.repeat(8));
    expect(row).toBeNull();
  });

  it('revoke makes verify return null', async () => {
    const created = await service.create('revoke-test');
    await service.revoke(created.id);
    const row = await service.verify(created.token);
    expect(row).toBeNull();
  });

  it('list returns token metadata without the hash', async () => {
    const created = await service.create('my-token');
    const list = await service.list();
    const row = list.find((t) => t.id === created.id);
    expect(row).toMatchObject({
      id: created.id,
      label: 'my-token',
      revoked_at: null,
    });
    expect(row).not.toHaveProperty('token_hash');
    expect(JSON.stringify(list)).not.toContain(created.token); // plaintext never present
  });
});
