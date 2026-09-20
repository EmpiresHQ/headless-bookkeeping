import { Kysely, SqliteDialect, sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import SqliteDb from 'better-sqlite3';
import { Database } from '../types';
import { migrations } from './index';

/**
 * Migrations 072/073 (issue #203).
 *
 * The load-bearing property is what the migration does NOT do: a line posted
 * before provenance existed keeps NULL provenance. It is not back-filled with
 * a source it never had, because that would retroactively bless a rate nobody
 * can trace — precisely the population the audit has to be able to find.
 */
describe('Migrations 072/073: FX rate cache + voucher-line provenance', () => {
  let db: Kysely<Database>;

  beforeEach(async () => {
    db = new Kysely<Database>({
      dialect: new SqliteDialect({ database: new SqliteDb(':memory:') }),
    });
    const migrator = new Migrator({
      db,
      provider: { getMigrations: () => Promise.resolve(migrations) },
    });
    const { error } = await migrator.migrateTo(
      '071_add_match_cash_base_amount',
    );
    expect(error).toBeUndefined();
  });

  afterEach(() => db.destroy());

  const migrateUp = async () => {
    const migrator = new Migrator({
      db,
      provider: { getMigrations: () => Promise.resolve(migrations) },
    });
    const { error } = await migrator.migrateToLatest();
    expect(error).toBeUndefined();
  };

  /** A legacy voucher + line, seeded in the pre-073 shape. */
  async function seedLegacyLine(fxRate: number): Promise<number> {
    const account = await db
      .selectFrom('account')
      .select('id')
      .executeTakeFirstOrThrow();
    const voucher = await db
      .insertInto('voucher')
      .values({
        voucher_number: `V-${fxRate}`,
        tax_point_date: '2025-06-02',
        posted_at: 1_750_000_000,
        previous_hash: null,
        reverses_id: null,
        corrects_object_type: null,
        corrects_object_id: null,
        reason: null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await sql`
      INSERT INTO voucher_line
        (voucher_id, account_id, amount, currency, base_amount, fx_rate, vat_code, is_debit)
      VALUES
        (${voucher.id}, ${account.id}, 10000, 'USD', 9200, ${fxRate}, NULL, 1)
    `.execute(db);
    return voucher.id;
  }

  it('leaves a pre-existing posted line UNATTRIBUTED — never back-filled', async () => {
    const voucherId = await seedLegacyLine(0.92);
    await migrateUp();

    const line = await db
      .selectFrom('voucher_line')
      .select(['fx_rate', 'fx_rate_date', 'fx_rate_source'])
      .where('voucher_id', '=', voucherId)
      .executeTakeFirstOrThrow();

    expect(line.fx_rate).toBeCloseTo(0.92, 10);
    // The whole point: distinguishable, not blessed.
    expect(line.fx_rate_date).toBeNull();
    expect(line.fx_rate_source).toBeNull();
  });

  it('keeps posted lines immutable — the new columns are not an edit hatch', async () => {
    const voucherId = await seedLegacyLine(0.92);
    await migrateUp();

    await expect(
      db
        .updateTable('voucher_line')
        .set({ fx_rate_source: 'ECB' })
        .where('voucher_id', '=', voucherId)
        .execute(),
    ).rejects.toThrow(/immutable/);
  });

  it('accepts an observation and refuses a non-positive rate', async () => {
    await migrateUp();
    await db
      .insertInto('fx_reference_rate')
      .values({
        source: 'ECB',
        base_currency: 'EUR',
        quote_currency: 'USD',
        rate_date: '2026-03-06',
        rate: 1.2,
        fetched_at: 1,
      })
      .execute();

    await expect(
      db
        .insertInto('fx_reference_rate')
        .values({
          source: 'ECB',
          base_currency: 'EUR',
          quote_currency: 'USD',
          rate_date: '2026-03-07',
          rate: 0,
          fetched_at: 1,
        })
        .execute(),
    ).rejects.toThrow();
  });

  it('holds one observation per (source, pair, date)', async () => {
    await migrateUp();
    const row = {
      source: 'ECB',
      base_currency: 'EUR',
      quote_currency: 'USD',
      rate_date: '2026-03-06',
      rate: 1.2,
      fetched_at: 1,
    };
    await db.insertInto('fx_reference_rate').values(row).execute();
    await expect(
      db
        .insertInto('fx_reference_rate')
        .values({ ...row, rate: 9.9 })
        .execute(),
    ).rejects.toThrow();
  });

  it('records probe windows separately from observations', async () => {
    await migrateUp();
    await db
      .insertInto('fx_rate_probe')
      .values({
        source: 'ECB',
        base_currency: 'EUR',
        quote_currency: 'USD',
        from_date: '2026-02-28',
        to_date: '2026-03-06',
        probed_at: 1,
      })
      .execute();

    const probes = await db.selectFrom('fx_rate_probe').selectAll().execute();
    // "We looked at this window" is a different fact from "a rate exists".
    expect(probes).toHaveLength(1);
    expect(probes[0].to_date).toBe('2026-03-06');
  });

  it('rolls back cleanly', async () => {
    await migrateUp();
    const migrator = new Migrator({
      db,
      provider: { getMigrations: () => Promise.resolve(migrations) },
    });
    const { error } = await migrator.migrateTo(
      '071_add_match_cash_base_amount',
    );
    expect(error).toBeUndefined();

    const columns = await sql<{
      name: string;
    }>`SELECT name FROM pragma_table_info('voucher_line')`.execute(db);
    expect(columns.rows.map((c) => c.name)).not.toContain('fx_rate_source');
  });
});
