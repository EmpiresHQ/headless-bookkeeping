import { Kysely, SqliteDialect, sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import Database from 'better-sqlite3';
import { Database as DBType } from './types';
import { migrations } from './migrations';

describe('DatabaseModule', () => {
  let db: Kysely<DBType>;

  beforeEach(async () => {
    db = new Kysely<DBType>({
      dialect: new SqliteDialect({
        database: new Database(':memory:'),
      }),
    });

    const migrator = new Migrator({
      db,
      provider: { getMigrations: () => Promise.resolve(migrations) },
    });
    const { error } = await migrator.migrateToLatest();
    if (error)
      throw error instanceof Error ? error : new Error('Migration failed');
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('should create the organization table', async () => {
    const orgs = await db.selectFrom('organization').select('id').execute();
    expect(orgs).toBeDefined();
  });

  it('should seed a default Irish organization with id=1 and no currency override', async () => {
    const orgs = await db.selectFrom('organization').selectAll().execute();

    expect(orgs).toHaveLength(1);
    expect(orgs[0].id).toBe(1);
    expect(orgs[0].country).toBe('IE');
    expect(orgs[0].base_currency).toBeNull();
    expect(orgs[0].vat_registered).toBe(0);
    expect(orgs[0].created_at).toBeDefined();
  });

  it('should reject a second organization row (DB-level singleton)', async () => {
    await expect(
      db
        .insertInto('organization')
        .values({
          id: 2,
          country: 'DE',
          base_currency: 'USD',
          vat_registered: 0,
          created_at: 1700000000,
        })
        .execute(),
    ).rejects.toThrow();
  });

  it('should have correct organization table columns', async () => {
    const row = await db
      .selectFrom('organization')
      .select([
        'id',
        'country',
        'base_currency',
        'vat_registered',
        'created_at',
      ])
      .executeTakeFirst();
    expect(row).toBeDefined();
    expect(row).toHaveProperty('base_currency');
    expect(row).toHaveProperty('country');
    expect(row).toHaveProperty('created_at');
    expect(row).toHaveProperty('id');
    expect(row).toHaveProperty('vat_registered');
  });

  it('proves the singleton CHECK lives in the shipping migration', async () => {
    const ddl = await sql<{ sql: string }>`
      SELECT sql FROM sqlite_master WHERE type='table' AND name='organization'
    `.execute(db);
    expect(ddl.rows[0].sql).toContain('id = 1');
  });

  it('seeds DISTRIBUTION_TAX_PAYABLE (liability) after migration 034', async () => {
    const row = await db
      .selectFrom('account')
      .selectAll()
      .where('code', '=', 'DISTRIBUTION_TAX_PAYABLE')
      .executeTakeFirstOrThrow();
    expect(row.type).toBe('liability');
  });
});
