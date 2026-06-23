import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import SqliteDb from 'better-sqlite3';
import { Database } from '../types';
import { migrations } from './index';

describe('Migration 054: widen entity role + add tg_user_id identifier kind', () => {
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
    expect(error).toBeUndefined();
  });

  afterEach(() => db.destroy());

  it('allows employee and director roles', async () => {
    const now = Math.floor(Date.now() / 1000);
    const emp = await db
      .insertInto('entity')
      .values({
        role: 'employee',
        country: 'EE',
        name: 'Alice',
        goods_vs_services: null,
        created_at: now,
        updated_at: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    expect(emp.role).toBe('employee');

    const dir = await db
      .insertInto('entity')
      .values({
        role: 'director',
        country: 'EE',
        name: 'Bob',
        goods_vs_services: null,
        created_at: now,
        updated_at: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    expect(dir.role).toBe('director');
  });

  it('allows tg_user_id as identifier kind', async () => {
    const now = Math.floor(Date.now() / 1000);
    const entity = await db
      .insertInto('entity')
      .values({
        role: 'employee',
        country: 'EE',
        name: 'Alice',
        goods_vs_services: null,
        created_at: now,
        updated_at: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    const ident = await db
      .insertInto('entity_identifier')
      .values({
        entity_id: entity.id,
        kind: 'tg_user_id',
        value: '123456789',
        confirmed: 1,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    expect(ident.kind).toBe('tg_user_id');
  });
});
