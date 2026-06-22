import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import SqliteDb from 'better-sqlite3';
import { Database } from '../types';
import { migrations } from './index';

describe('migration 051 — api_token lifecycle columns', () => {
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

  it('defaults kind to static and lifecycle columns to null', async () => {
    await db
      .insertInto('api_token')
      .values({ token_hash: 'h1', label: 'x' })
      .execute();
    const row = await db
      .selectFrom('api_token')
      .select(['kind', 'expires_at', 'consumed_at'])
      .executeTakeFirstOrThrow();
    expect(row.kind).toBe('static');
    expect(row.expires_at).toBeNull();
    expect(row.consumed_at).toBeNull();
  });

  it('accepts an enrollment row with expiry', async () => {
    await db
      .insertInto('api_token')
      .values({
        token_hash: 'h2',
        label: 'enroll',
        kind: 'enrollment',
        expires_at: 1750000000,
      })
      .execute();
    const row = await db
      .selectFrom('api_token')
      .select(['kind', 'expires_at'])
      .where('token_hash', '=', 'h2')
      .executeTakeFirstOrThrow();
    expect(row.kind).toBe('enrollment');
    expect(row.expires_at).toBe(1750000000);
  });
});
