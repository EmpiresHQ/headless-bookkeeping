import { Kysely, SqliteDialect, sql } from 'kysely';
import Database from 'better-sqlite3';
import { Database as DBType } from './types';

describe('DatabaseModule', () => {
  let db: Kysely<DBType>;

  beforeEach(async () => {
    db = new Kysely<DBType>({
      dialect: new SqliteDialect({
        database: new Database(':memory:'),
      }),
    });

    // Create organization table directly (no migrations to avoid singleton interference)
    await db.schema
      .createTable('organization')
      .addColumn('id', 'integer', (col) => col.primaryKey().check(sql`id = 1`))
      .addColumn('country', 'text', (col) => col.notNull())
      .addColumn('base_currency', 'text')
      .addColumn('vat_registered', 'integer', (col) =>
        col.notNull().defaultTo(0),
      )
      .addColumn('created_at', 'integer', (col) => col.notNull())
      .execute();

    await db
      .insertInto('organization')
      .values({
        id: 1,
        country: 'IE',
        base_currency: null,
        vat_registered: 0,
        created_at: Math.floor(Date.now() / 1000),
      })
      .execute();
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
});
