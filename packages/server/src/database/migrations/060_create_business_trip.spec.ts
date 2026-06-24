import { Kysely, SqliteDialect, sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import SqliteDb from 'better-sqlite3';
import { Database } from '../types';
import { migrations } from './index';

describe('Migration 060: create business_trip table', () => {
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

  it('creates business_trip table', async () => {
    const result = await sql<{
      name: string;
    }>`PRAGMA table_info(business_trip)`.execute(db);
    const colNames = result.rows.map((r) => r.name);
    expect(colNames).toContain('id');
    expect(colNames).toContain('claimant_id');
    expect(colNames).toContain('departure_date');
    expect(colNames).toContain('return_date');
    expect(colNames).toContain('destination_country');
    expect(colNames).toContain('purpose');
    expect(colNames).toContain('created_at');
    expect(colNames).toContain('updated_at');
  });

  it('enforces NOT NULL on claimant_id', async () => {
    const now = Math.floor(Date.now() / 1000);
    await expect(
      db
        .insertInto('business_trip')
        .values({
          departure_date: '2026-06-01',
          return_date: '2026-06-05',
          destination_country: 'FR',
          created_at: now,
          updated_at: now,
        })
        .execute(),
    ).rejects.toThrow();
  });

  it('enforces FK on claimant_id — rejects non-existent entity id', async () => {
    const now = Math.floor(Date.now() / 1000);
    await expect(
      db
        .insertInto('business_trip')
        .values({
          claimant_id: 99999,
          departure_date: '2026-06-01',
          return_date: '2026-06-05',
          destination_country: 'FR',
          created_at: now,
          updated_at: now,
        })
        .execute(),
    ).rejects.toThrow();
  });

  it('accepts a valid claimant_id FK pointing at an existing entity', async () => {
    const now = Math.floor(Date.now() / 1000);
    const entity = await db
      .insertInto('entity')
      .values({
        role: 'employee',
        country: 'EE',
        name: 'Alice Tamm',
        goods_vs_services: null,
        created_at: now,
        updated_at: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    const trip = await db
      .insertInto('business_trip')
      .values({
        claimant_id: entity.id,
        departure_date: '2026-06-01',
        return_date: '2026-06-05',
        destination_country: 'FR',
        created_at: now,
        updated_at: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    expect(trip.claimant_id).toBe(entity.id);
  });

  it('enforces NOT NULL on departure_date', async () => {
    const now = Math.floor(Date.now() / 1000);
    const entity = await db
      .insertInto('entity')
      .values({
        role: 'employee',
        country: 'EE',
        name: 'Alice Tamm',
        goods_vs_services: null,
        created_at: now,
        updated_at: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await expect(
      db
        .insertInto('business_trip')
        .values({
          claimant_id: entity.id,
          return_date: '2026-06-05',
          destination_country: 'FR',
          created_at: now,
          updated_at: now,
        })
        .execute(),
    ).rejects.toThrow();
  });

  it('enforces NOT NULL on return_date', async () => {
    const now = Math.floor(Date.now() / 1000);
    const entity = await db
      .insertInto('entity')
      .values({
        role: 'employee',
        country: 'EE',
        name: 'Alice Tamm',
        goods_vs_services: null,
        created_at: now,
        updated_at: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await expect(
      db
        .insertInto('business_trip')
        .values({
          claimant_id: entity.id,
          departure_date: '2026-06-01',
          destination_country: 'FR',
          created_at: now,
          updated_at: now,
        })
        .execute(),
    ).rejects.toThrow();
  });

  it('enforces NOT NULL on destination_country', async () => {
    const now = Math.floor(Date.now() / 1000);
    const entity = await db
      .insertInto('entity')
      .values({
        role: 'employee',
        country: 'EE',
        name: 'Alice Tamm',
        goods_vs_services: null,
        created_at: now,
        updated_at: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await expect(
      db
        .insertInto('business_trip')
        .values({
          claimant_id: entity.id,
          departure_date: '2026-06-01',
          return_date: '2026-06-05',
          created_at: now,
          updated_at: now,
        })
        .execute(),
    ).rejects.toThrow();
  });

  it('allows null purpose', async () => {
    const now = Math.floor(Date.now() / 1000);
    const entity = await db
      .insertInto('entity')
      .values({
        role: 'employee',
        country: 'EE',
        name: 'Alice Tamm',
        goods_vs_services: null,
        created_at: now,
        updated_at: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    const trip = await db
      .insertInto('business_trip')
      .values({
        claimant_id: entity.id,
        departure_date: '2026-06-01',
        return_date: '2026-06-05',
        destination_country: 'FR',
        purpose: null,
        created_at: now,
        updated_at: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    expect(trip.purpose).toBeNull();
  });

  it('DOWN migration removes the table', async () => {
    const migrator = new Migrator({
      db,
      provider: { getMigrations: () => Promise.resolve(migrations) },
    });
    const { error } = await migrator.migrateTo('059_widen_document_source_channel');
    expect(error).toBeUndefined();

    const result = await sql<{
      name: string;
    }>`SELECT name FROM sqlite_master WHERE type='table' AND name='business_trip'`.execute(
      db,
    );
    expect(result.rows).toHaveLength(0);
  });
});
