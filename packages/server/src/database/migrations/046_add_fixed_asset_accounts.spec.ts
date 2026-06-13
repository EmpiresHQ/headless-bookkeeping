import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import SqliteDb from 'better-sqlite3';
import { Database } from '../types';
import { migrations } from './index';

describe('migration 046 — fixed-asset accounts', () => {
  let db: Kysely<Database>;

  beforeEach(async () => {
    const rawDb = new SqliteDb(':memory:');
    rawDb.pragma('foreign_keys = ON');
    db = new Kysely<Database>({
      dialect: new SqliteDialect({ database: rawDb }),
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

  it('seeds every neutral fixed-asset account with the correct type', async () => {
    const expected: Record<string, string> = {
      FIXED_ASSETS_VEHICLES: 'asset',
      FIXED_ASSETS_IT: 'asset',
      FIXED_ASSETS_EQUIPMENT: 'asset',
      FIXED_ASSETS_FURNITURE: 'asset',
      ACCUM_DEPRECIATION_VEHICLES: 'asset',
      ACCUM_DEPRECIATION_IT: 'asset',
      ACCUM_DEPRECIATION_EQUIPMENT: 'asset',
      ACCUM_DEPRECIATION_FURNITURE: 'asset',
      DEPRECIATION_EXPENSE: 'expense',
      GAIN_LOSS_ON_ASSET_DISPOSAL: 'revenue',
    };
    const rows = await db
      .selectFrom('account')
      .select(['code', 'type', 'is_system'])
      .where('code', 'in', Object.keys(expected))
      .execute();

    expect(rows).toHaveLength(Object.keys(expected).length);
    for (const r of rows) {
      expect(r.type).toBe(expected[r.code]);
      expect(r.is_system).toBe(1);
    }
  });
});
