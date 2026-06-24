import { Kysely, SqliteDialect, sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import SqliteDb from 'better-sqlite3';
import { Database } from '../types';
import { migrations } from './index';

describe('Migration 061: create allowance table', () => {
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

  it('creates allowance table', async () => {
    const result = await sql<{
      name: string;
    }>`PRAGMA table_info(allowance)`.execute(db);
    const colNames = result.rows.map((r) => r.name);
    expect(colNames).toContain('id');
    expect(colNames).toContain('claimant_id');
    expect(colNames).toContain('trip_id');
    expect(colNames).toContain('type');
    expect(colNames).toContain('gross_amount');
    expect(colNames).toContain('tax_free_amount');
    expect(colNames).toContain('taxable_amount');
    expect(colNames).toContain('period_start');
    expect(colNames).toContain('status');
  });

  it('enforces NOT NULL on claimant_id', async () => {
    const now = Math.floor(Date.now() / 1000);
    await expect(
      db
        .insertInto('allowance')
        // @ts-expect-error intentionally incomplete insert to test NOT NULL constraint
        .values({
          type: 'accommodation',
          gross_amount: 10000,
          tax_free_amount: 10000,
          taxable_amount: 0,
          period_start: '2026-06-01',
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
        .insertInto('allowance')
        .values({
          claimant_id: 99999,
          type: 'accommodation',
          gross_amount: 10000,
          tax_free_amount: 10000,
          taxable_amount: 0,
          period_start: '2026-06-01',
          created_at: now,
          updated_at: now,
        })
        .execute(),
    ).rejects.toThrow();
  });

  it('enforces FK on trip_id — rejects non-existent business_trip id', async () => {
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
        .insertInto('allowance')
        .values({
          claimant_id: entity.id,
          trip_id: 99999,
          type: 'accommodation',
          gross_amount: 10000,
          tax_free_amount: 10000,
          taxable_amount: 0,
          period_start: '2026-06-01',
          created_at: now,
          updated_at: now,
        })
        .execute(),
    ).rejects.toThrow();
  });

  it('accepts valid trip_id FK pointing at an existing business_trip', async () => {
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

    const allowance = await db
      .insertInto('allowance')
      .values({
        claimant_id: entity.id,
        trip_id: trip.id,
        type: 'accommodation',
        gross_amount: 10000,
        tax_free_amount: 10000,
        taxable_amount: 0,
        period_start: '2026-06-01',
        created_at: now,
        updated_at: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    expect(allowance.trip_id).toBe(trip.id);
  });

  it('allows trip_id to be null (standalone allowance)', async () => {
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

    const allowance = await db
      .insertInto('allowance')
      .values({
        claimant_id: entity.id,
        trip_id: null,
        type: 'overtime',
        gross_amount: 5000,
        tax_free_amount: 0,
        taxable_amount: 5000,
        period_start: '2026-06-01',
        created_at: now,
        updated_at: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    expect(allowance.trip_id).toBeNull();
  });

  it('enforces NOT NULL on type', async () => {
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
        .insertInto('allowance')
        // @ts-expect-error intentionally incomplete insert to test NOT NULL constraint
        .values({
          claimant_id: entity.id,
          gross_amount: 10000,
          tax_free_amount: 10000,
          taxable_amount: 0,
          period_start: '2026-06-01',
          created_at: now,
          updated_at: now,
        })
        .execute(),
    ).rejects.toThrow();
  });

  it('enforces NOT NULL on gross_amount', async () => {
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
        .insertInto('allowance')
        // @ts-expect-error intentionally incomplete insert to test NOT NULL constraint
        .values({
          claimant_id: entity.id,
          type: 'accommodation',
          tax_free_amount: 10000,
          taxable_amount: 0,
          period_start: '2026-06-01',
          created_at: now,
          updated_at: now,
        })
        .execute(),
    ).rejects.toThrow();
  });

  it('enforces NOT NULL on tax_free_amount', async () => {
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
        .insertInto('allowance')
        // @ts-expect-error intentionally incomplete insert to test NOT NULL constraint
        .values({
          claimant_id: entity.id,
          type: 'accommodation',
          gross_amount: 10000,
          taxable_amount: 0,
          period_start: '2026-06-01',
          created_at: now,
          updated_at: now,
        })
        .execute(),
    ).rejects.toThrow();
  });

  it('enforces NOT NULL on taxable_amount', async () => {
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
        .insertInto('allowance')
        // @ts-expect-error intentionally incomplete insert to test NOT NULL constraint
        .values({
          claimant_id: entity.id,
          type: 'accommodation',
          gross_amount: 10000,
          tax_free_amount: 10000,
          period_start: '2026-06-01',
          created_at: now,
          updated_at: now,
        })
        .execute(),
    ).rejects.toThrow();
  });

  it('enforces NOT NULL on period_start', async () => {
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
        .insertInto('allowance')
        // @ts-expect-error intentionally incomplete insert to test NOT NULL constraint
        .values({
          claimant_id: entity.id,
          type: 'accommodation',
          gross_amount: 10000,
          tax_free_amount: 10000,
          taxable_amount: 0,
          created_at: now,
          updated_at: now,
        })
        .execute(),
    ).rejects.toThrow();
  });

  it('defaults status to "draft"', async () => {
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

    const allowance = await db
      .insertInto('allowance')
      .values({
        claimant_id: entity.id,
        type: 'accommodation',
        gross_amount: 10000,
        tax_free_amount: 10000,
        taxable_amount: 0,
        period_start: '2026-06-01',
        created_at: now,
        updated_at: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    expect(allowance.status).toBe('draft');
  });

  it('defaults currency to "EUR"', async () => {
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

    const allowance = await db
      .insertInto('allowance')
      .values({
        claimant_id: entity.id,
        type: 'accommodation',
        gross_amount: 10000,
        tax_free_amount: 10000,
        taxable_amount: 0,
        period_start: '2026-06-01',
        created_at: now,
        updated_at: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    expect(allowance.currency).toBe('EUR');
  });

  it('DOWN migration removes the table', async () => {
    const migrator = new Migrator({
      db,
      provider: { getMigrations: () => Promise.resolve(migrations) },
    });
    const { error } = await migrator.migrateTo('061_create_business_trip');
    expect(error).toBeUndefined();

    const result = await sql<{
      name: string;
    }>`SELECT name FROM sqlite_master WHERE type='table' AND name='allowance'`.execute(
      db,
    );
    expect(result.rows).toHaveLength(0);
  });
});
