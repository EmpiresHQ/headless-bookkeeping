import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import SqliteDb from 'better-sqlite3';
import { Database } from '../types';
import { migrations } from './index';

/**
 * Issue #207. The two timelines are introduced by adding a column, not by
 * moving anything: every period that existed before this migration IS a VAT
 * period, keeps its id, its lock, its `filed_at` and its snapshot binding, and
 * every voucher that existed before is ordinary activity (no annual-close mark).
 */
it('marks every existing period as a VAT period, leaves ids/locks/snapshots intact, and rolls back cleanly', async () => {
  const db = new Kysely<Database>({
    dialect: new SqliteDialect({ database: new SqliteDb(':memory:') }),
  });
  try {
    const migrator = new Migrator({
      db,
      provider: { getMigrations: () => Promise.resolve(migrations) },
    });
    expect(
      (await migrator.migrateTo('073_add_voucher_line_fx_provenance')).error,
    ).toBeUndefined();

    // A legacy FILED period, bound to a frozen snapshot, plus a legacy voucher.
    await db
      .insertInto('reporting_period')
      .values({
        name: '2025-12',
        start_date: '2025-12-01',
        end_date: '2025-12-31',
        status: 'locked',
        filed_at: 1700000000,
        vat_report_snapshot_id: 42,
        created_at: 1,
      } as never)
      .execute();
    await db
      .insertInto('voucher')
      .values({
        voucher_number: 'V-2025-000001',
        tax_point_date: '2025-12-15',
        posted_at: 1700000000,
      })
      .execute();

    expect((await migrator.migrateToLatest()).error).toBeUndefined();

    const filed = await db
      .selectFrom('reporting_period')
      .selectAll()
      .where('name', '=', '2025-12')
      .executeTakeFirstOrThrow();
    expect(filed).toMatchObject({
      kind: 'vat',
      status: 'locked',
      filed_at: 1700000000,
      vat_report_snapshot_id: 42,
    });

    // The period seeded by migration 011 is a VAT period too.
    const seeded = await db
      .selectFrom('reporting_period')
      .selectAll()
      .where('name', '=', '2024-Q1')
      .executeTakeFirstOrThrow();
    expect(seeded.kind).toBe('vat');

    const voucher = await db
      .selectFrom('voucher')
      .selectAll()
      .where('voucher_number', '=', 'V-2025-000001')
      .executeTakeFirstOrThrow();
    expect(voucher.annual_close_period_id).toBeNull();

    // A financial year is expressible, and coexists with the filed December.
    await db
      .insertInto('reporting_period')
      .values({
        name: 'FY2025',
        start_date: '2025-01-01',
        end_date: '2025-12-31',
        kind: 'annual',
        status: 'open',
        created_at: 1,
      } as never)
      .execute();
    expect(
      await db
        .selectFrom('reporting_period')
        .select('name')
        .where('kind', '=', 'annual')
        .execute(),
    ).toEqual([{ name: 'FY2025' }]);

    // Roll back TO the pre-074 state by name (see 066's spec for why by name).
    await db
      .deleteFrom('reporting_period')
      .where('kind', '=', 'annual')
      .execute();
    expect(
      (await migrator.migrateTo('073_add_voucher_line_fx_provenance')).error,
    ).toBeUndefined();
    const rolledBack = await db
      .selectFrom('reporting_period')
      .selectAll()
      .where('name', '=', '2025-12')
      .executeTakeFirstOrThrow();
    expect(rolledBack).not.toHaveProperty('kind');
    expect(rolledBack.status).toBe('locked');
    expect(rolledBack.vat_report_snapshot_id).toBe(42);
    expect(
      await db
        .selectFrom('voucher')
        .selectAll()
        .where('voucher_number', '=', 'V-2025-000001')
        .executeTakeFirstOrThrow(),
    ).not.toHaveProperty('annual_close_period_id');
  } finally {
    await db.destroy();
  }
});
