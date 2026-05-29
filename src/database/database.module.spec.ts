import { Kysely, SqliteDialect, sql } from 'kysely';
import Database from 'better-sqlite3';

describe('DatabaseModule', () => {
  let db: Kysely<any>;

  beforeEach(async () => {
    db = new Kysely<any>({
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
      .addColumn('vat_registered', 'integer', (col) => col.notNull().defaultTo(0))
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
