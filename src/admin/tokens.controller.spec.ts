import { Test, TestingModule } from '@nestjs/testing';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import SqliteDb from 'better-sqlite3';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import { Database } from '../database/types';
import { migrations } from '../database/migrations';
import { ApiTokenService } from '../auth/api-token.service';
import { TokensController } from './tokens.controller';

describe('TokensController (real-DI)', () => {
  let db: Kysely<Database>;
  let controller: TokensController;

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
      controllers: [TokensController],
      providers: [
        { provide: KYSELY_MODULE_CONNECTION_TOKEN(), useValue: db },
        ApiTokenService,
      ],
    }).compile();

    controller = module.get<TokensController>(TokensController);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('POST creates a token, returns plaintext ONCE', async () => {
    const res = await controller.create({ label: 'ci' });
    expect(res.token).toMatch(/^[0-9a-f]{64}$/);
    expect(res.id).toBeGreaterThan(0);
  });

  it('GET lists token metadata (no plaintext, no hash)', async () => {
    const created = await controller.create({ label: 'ci' });
    const res = await controller.list();
    expect(
      res.tokens.some((t) => t.id === created.id && t.label === 'ci'),
    ).toBe(true);
    expect(JSON.stringify(res.tokens)).not.toContain(created.token);
  });

  it('DELETE revokes a token', async () => {
    const created = await controller.create({ label: 'tmp' });
    await controller.revoke(created.id);
    const row = await db
      .selectFrom('api_token')
      .select('revoked_at')
      .where('id', '=', created.id)
      .executeTakeFirstOrThrow();
    expect(row.revoked_at).not.toBeNull();
  });
});
