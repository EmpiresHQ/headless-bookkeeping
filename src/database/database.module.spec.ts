import { Kysely, SqliteDialect, sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import Database from 'better-sqlite3';
import { migrations } from './migrations';

describe('DatabaseModule', () => {
  let db: Kysely<any>;

  beforeEach(async () => {
    db = new Kysely<any>({
      dialect: new SqliteDialect({
        database: new Database(':memory:'),
      }),
    });

    const migrator = new Migrator({
      db,
      provider: {
        getMigrations: () => Promise.resolve(migrations),
      },
    });
    const { error } = await migrator.migrateToLatest();
    if (error)
      throw error instanceof Error ? error : new Error('Migration failed');
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('should create the organization table', async () => {
    const tables = await db
      .selectFrom('sqlite_master')
      .select('name')
      .where('type', '=', 'table')
      .where('name', '=', 'organization')
      .execute();

    expect(tables).toHaveLength(1);
    expect(tables[0].name).toBe('organization');
  });

  it('should seed a default Irish organization with id=1 and no currency override', async () => {
    const orgs = await db.selectFrom('organization').selectAll().execute();

    expect(orgs).toHaveLength(1);
    expect(orgs[0].id).toBe(1);
    expect(orgs[0].country).toBe('IE');
    // base_currency is a nullable override; NULL means "inherit from the
    // country plugin" (ADR-0004). The seed leaves it unset.
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
    const columns = await sql<{
      name: string;
    }>`SELECT name FROM pragma_table_info('organization')`.execute(db);

    const columnNames = columns.rows.map((c) => c.name).sort();
    expect(columnNames).toEqual([
      'base_currency',
      'country',
      'created_at',
      'id',
      'vat_registered',
    ]);
  });
});
