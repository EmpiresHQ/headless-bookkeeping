import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import SqliteDb from 'better-sqlite3';
import { Database } from '../types';
import { migrations } from './index';

describe('migration 047 — fixed_asset table', () => {
  let db: Kysely<Database>;

  beforeEach(async () => {
    const rawDb = new SqliteDb(':memory:');
    rawDb.pragma('foreign_keys = ON');
    db = new Kysely<Database>({ dialect: new SqliteDialect({ database: rawDb }) });
    const migrator = new Migrator({
      db,
      provider: { getMigrations: () => Promise.resolve(migrations) },
    });
    const { error } = await migrator.migrateToLatest();
    if (error) throw error instanceof Error ? error : new Error('Migration failed');
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('inserts and reads back a fixed_asset row (mutable retired_at)', async () => {
    const voucher = await db
      .insertInto('voucher')
      .values({
        voucher_number: 'V-2026-000001',
        tax_point_date: '2026-01-15',
        posted_at: 1,
        previous_hash: null,
        reverses_id: null,
        corrects_object_type: null,
        corrects_object_id: null,
        reason: null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    const inserted = await db
      .insertInto('fixed_asset')
      .values({
        name: 'Company car',
        asset_class: 'vehicle',
        acquisition_voucher_id: voucher.id,
        acquisition_date: '2026-01-15',
        cost_base_minor: 2000000,
        useful_life_years: 5,
        residual_value_minor: 400000,
        retired_at: null,
        disposal_voucher_id: null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    expect(inserted.id).toBeGreaterThan(0);
    expect(inserted.retired_at).toBeNull();

    // Master data, not append-only: an UPDATE must succeed (no trigger).
    await db
      .updateTable('fixed_asset')
      .set({ retired_at: 999, disposal_voucher_id: voucher.id })
      .where('id', '=', inserted.id)
      .execute();

    const after = await db
      .selectFrom('fixed_asset')
      .selectAll()
      .where('id', '=', inserted.id)
      .executeTakeFirstOrThrow();
    expect(after.retired_at).toBe(999);
  });

  it('rejects an unknown asset_class via the CHECK constraint', async () => {
    const voucher = await db
      .insertInto('voucher')
      .values({
        voucher_number: 'V-2026-000002',
        tax_point_date: '2026-01-15',
        posted_at: 1,
        previous_hash: null,
        reverses_id: null,
        corrects_object_type: null,
        corrects_object_id: null,
        reason: null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await expect(
      db
        .insertInto('fixed_asset')
        .values({
          name: 'Bad',
          asset_class: 'spaceship',
          acquisition_voucher_id: voucher.id,
          acquisition_date: '2026-01-15',
          cost_base_minor: 1,
          useful_life_years: 1,
          residual_value_minor: 0,
          retired_at: null,
          disposal_voucher_id: null,
        })
        .execute(),
    ).rejects.toThrow();
  });
});
