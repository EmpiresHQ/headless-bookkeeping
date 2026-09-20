import { Kysely, SqliteDialect, sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import SqliteDb from 'better-sqlite3';
import { Database } from '../types';
import { migrations } from './index';
import { expectDbRefusal } from '../../../test/expect-db-refusal';

/**
 * Migration 075's LEGACY BACK-FILL (issue #208).
 *
 * The interesting case cannot be produced by the services, because after this
 * migration they attribute as they post. So the database is migrated to 074 —
 * the world as it was — a close is posted there by hand exactly as the old
 * annual close posted it (one voucher, one aggregated line per class), and the
 * migration is then run over it.
 *
 * What is asserted is the rule the back-fill lives by: a split is written only
 * where the evidence identifies it AND reconciles to the cent, and anything
 * else is left visibly unattributed rather than guessed at.
 */
describe('Migration 075 — legacy annual-close back-fill', () => {
  let db: Kysely<Database>;
  let raw: SqliteDb.Database;

  const LAST_BEFORE = '074_add_reporting_period_kind';

  beforeEach(async () => {
    raw = new SqliteDb(':memory:');
    raw.pragma('foreign_keys = ON');
    db = new Kysely<Database>({
      dialect: new SqliteDialect({ database: raw }),
    });
    const migrator = new Migrator({
      db,
      provider: { getMigrations: () => Promise.resolve(migrations) },
    });
    const { error } = await migrator.migrateTo(LAST_BEFORE);
    if (error)
      throw error instanceof Error ? error : new Error('migrate failed');
  });

  afterEach(async () => {
    await db.destroy();
  });

  async function migrateToLatest(): Promise<void> {
    const migrator = new Migrator({
      db,
      provider: { getMigrations: () => Promise.resolve(migrations) },
    });
    const { error } = await migrator.migrateToLatest();
    if (error)
      throw error instanceof Error ? error : new Error('migrate failed');
  }

  async function accountId(code: string): Promise<number> {
    const row = await db
      .selectFrom('account')
      .select('id')
      .where('code', '=', code)
      .executeTakeFirstOrThrow();
    return row.id;
  }

  /**
   * A posted voucher written straight into the tables, the way a pre-075
   * database holds one. `voucher` is immutable via triggers, so everything the
   * row will ever say is written in the single INSERT.
   */
  let seq = 0;
  async function postRaw(
    taxPointDate: string,
    lines: Array<{ code: string; isDebit: boolean; base: number }>,
    extra: { reason?: string; reversesId?: number } = {},
  ): Promise<number> {
    seq += 1;
    const now = Math.floor(Date.now() / 1000);
    const res = await db
      .insertInto('voucher')
      .values({
        voucher_number: `V-TEST-${seq}`,
        tax_point_date: taxPointDate,
        posted_at: now,
        reason: extra.reason ?? null,
        reverses_id: extra.reversesId ?? null,
      } as never)
      .returning('id')
      .executeTakeFirstOrThrow();
    const voucherId = res.id as number;
    for (const l of lines) {
      await db
        .insertInto('voucher_line')
        .values({
          voucher_id: voucherId,
          account_id: await accountId(l.code),
          amount: l.base,
          currency: 'EUR',
          base_amount: l.base,
          fx_rate: 1,
          is_debit: l.isDebit ? 1 : 0,
        } as never)
        .execute();
    }
    return voucherId;
  }

  async function registerRaw(opts: {
    name: string;
    assetClass: string;
    date: string;
    costMinor: number;
    lifeYears: number;
    residualMinor?: number;
    accountCode: string;
  }): Promise<number> {
    const acq = await postRaw(opts.date, [
      { code: opts.accountCode, isDebit: true, base: opts.costMinor },
      { code: 'BANK_EUR', isDebit: false, base: opts.costMinor },
    ]);
    const row = await db
      .insertInto('fixed_asset')
      .values({
        name: opts.name,
        asset_class: opts.assetClass,
        acquisition_voucher_id: acq,
        acquisition_date: opts.date,
        cost_base_minor: opts.costMinor,
        useful_life_years: opts.lifeYears,
        residual_value_minor: opts.residualMinor ?? 0,
        retired_at: null,
      } as never)
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id as number;
  }

  async function seedYear(name: string, year: number): Promise<void> {
    await db
      .insertInto('reporting_period')
      .values({
        name,
        start_date: `${year}-01-01`,
        end_date: `${year}-12-31`,
        status: 'locked',
        kind: 'annual',
        created_at: Math.floor(Date.now() / 1000),
      } as never)
      .execute();
  }

  async function attribution(): Promise<
    Array<{ fixed_asset_id: number; amount_minor: number; source: string }>
  > {
    return db
      .selectFrom('fixed_asset_depreciation')
      .select(['fixed_asset_id', 'amount_minor', 'source'])
      .orderBy('fixed_asset_id')
      .execute();
  }

  it('re-derives the split of a reconciling legacy close, across differing lives and residuals', async () => {
    await seedYear('FY2026', 2026);
    const laptop = await registerRaw({
      name: 'Laptop',
      assetClass: 'it_equipment',
      date: '2026-01-01',
      costMinor: 120000,
      lifeYears: 4,
      accountCode: 'FIXED_ASSETS_IT',
    });
    const server = await registerRaw({
      name: 'Server',
      assetClass: 'it_equipment',
      date: '2026-07-01',
      costMinor: 240000,
      lifeYears: 5,
      residualMinor: 40000,
      accountCode: 'FIXED_ASSETS_IT',
    });
    // The aggregated close the old code posted: 30000 + 20000 on ONE line.
    await postRaw(
      '2026-12-31',
      [
        { code: 'DEPRECIATION_EXPENSE', isDebit: true, base: 50000 },
        { code: 'ACCUM_DEPRECIATION_IT', isDebit: false, base: 50000 },
      ],
      { reason: 'Annual depreciation charge for FY2026' },
    );

    await migrateToLatest();

    expect(await attribution()).toEqual([
      {
        fixed_asset_id: laptop,
        amount_minor: 30000,
        source: 'legacy_backfill',
      },
      {
        fixed_asset_id: server,
        amount_minor: 20000,
        source: 'legacy_backfill',
      },
    ]);
  });

  it('leaves a close it cannot reconcile completely unattributed', async () => {
    await seedYear('FY2026', 2026);
    await registerRaw({
      name: 'Laptop',
      assetClass: 'it_equipment',
      date: '2026-01-01',
      costMinor: 120000,
      lifeYears: 4,
      accountCode: 'FIXED_ASSETS_IT',
    });
    // The engine says 30000; the ledger carries 27500 (a hand-adjusted close,
    // an older rounding rule — the reason does not matter, the mismatch does).
    await postRaw(
      '2026-12-31',
      [
        { code: 'DEPRECIATION_EXPENSE', isDebit: true, base: 27500 },
        { code: 'ACCUM_DEPRECIATION_IT', isDebit: false, base: 27500 },
      ],
      { reason: 'Annual depreciation charge for FY2026' },
    );

    await migrateToLatest();

    // Nothing is assigned: not the engine's figure, not the posted figure
    // scaled onto the asset, nothing.
    expect(await attribution()).toEqual([]);
  });

  it('attributes only the class that reconciles when a close covers two classes', async () => {
    await seedYear('FY2026', 2026);
    const laptop = await registerRaw({
      name: 'Laptop',
      assetClass: 'it_equipment',
      date: '2026-01-01',
      costMinor: 120000,
      lifeYears: 4,
      accountCode: 'FIXED_ASSETS_IT',
    });
    await registerRaw({
      name: 'Van',
      assetClass: 'vehicle',
      date: '2026-01-01',
      costMinor: 500000,
      lifeYears: 5,
      accountCode: 'FIXED_ASSETS_VEHICLES',
    });
    // IT reconciles (30000); vehicles does not (engine 100000, posted 90000).
    await postRaw(
      '2026-12-31',
      [
        { code: 'DEPRECIATION_EXPENSE', isDebit: true, base: 120000 },
        { code: 'ACCUM_DEPRECIATION_IT', isDebit: false, base: 30000 },
        { code: 'ACCUM_DEPRECIATION_VEHICLES', isDebit: false, base: 90000 },
      ],
      { reason: 'Annual depreciation charge for FY2026' },
    );

    await migrateToLatest();

    expect(await attribution()).toEqual([
      {
        fixed_asset_id: laptop,
        amount_minor: 30000,
        source: 'legacy_backfill',
      },
    ]);
  });

  it('excludes an asset acquired after the close, and one already retired before it', async () => {
    await seedYear('FY2026', 2026);
    const kept = await registerRaw({
      name: 'Laptop',
      assetClass: 'it_equipment',
      date: '2026-01-01',
      costMinor: 120000,
      lifeYears: 4,
      accountCode: 'FIXED_ASSETS_IT',
    });
    // Retired BEFORE the close was posted: the old close skipped it, so the
    // back-fill must too — even though its acquisition date is in the year.
    const retired = await registerRaw({
      name: 'Old laptop',
      assetClass: 'it_equipment',
      date: '2026-01-01',
      costMinor: 60000,
      lifeYears: 3,
      accountCode: 'FIXED_ASSETS_IT',
    });
    const disposalVoucher = await postRaw('2026-06-30', [
      { code: 'FIXED_ASSETS_IT', isDebit: false, base: 60000 },
      { code: 'GAIN_LOSS_ON_ASSET_DISPOSAL', isDebit: true, base: 60000 },
    ]);
    await db
      .updateTable('fixed_asset')
      .set({
        retired_at: Math.floor(Date.now() / 1000),
        disposal_voucher_id: disposalVoucher,
      })
      .where('id', '=', retired)
      .execute();

    await postRaw(
      '2026-12-31',
      [
        { code: 'DEPRECIATION_EXPENSE', isDebit: true, base: 30000 },
        { code: 'ACCUM_DEPRECIATION_IT', isDebit: false, base: 30000 },
      ],
      { reason: 'Annual depreciation charge for FY2026' },
    );

    // Registered AFTER the close: its acquisition voucher comes later in the
    // sequence, so the close cannot have charged it. Its engine charge for
    // 2026 would be 15000, which would break the reconciliation if counted.
    const late = await registerRaw({
      name: 'Late laptop',
      assetClass: 'it_equipment',
      date: '2026-07-01',
      costMinor: 120000,
      lifeYears: 4,
      accountCode: 'FIXED_ASSETS_IT',
    });

    await migrateToLatest();

    const rows = await attribution();
    expect(rows).toEqual([
      { fixed_asset_id: kept, amount_minor: 30000, source: 'legacy_backfill' },
    ]);
    expect(rows.some((r) => r.fixed_asset_id === late)).toBe(false);
    expect(rows.some((r) => r.fixed_asset_id === retired)).toBe(false);
  });

  it('nets a prior year, so the second year attributes only its own charge', async () => {
    await seedYear('FY2026', 2026);
    await seedYear('FY2027', 2027);
    const laptop = await registerRaw({
      name: 'Laptop',
      assetClass: 'it_equipment',
      date: '2026-01-01',
      costMinor: 120000,
      lifeYears: 4,
      accountCode: 'FIXED_ASSETS_IT',
    });
    for (const year of ['FY2026', 'FY2027']) {
      await postRaw(
        `${year.slice(2)}-12-31`,
        [
          { code: 'DEPRECIATION_EXPENSE', isDebit: true, base: 30000 },
          { code: 'ACCUM_DEPRECIATION_IT', isDebit: false, base: 30000 },
        ],
        { reason: `Annual depreciation charge for ${year}` },
      );
    }

    await migrateToLatest();

    const rows = await db
      .selectFrom('fixed_asset_depreciation')
      .select(['amount_minor'])
      .where('fixed_asset_id', '=', laptop)
      .execute();
    expect(rows.map((r) => r.amount_minor)).toEqual([30000, 30000]);
  });

  it('keeps the attribution rows append-only', async () => {
    await seedYear('FY2026', 2026);
    const laptop = await registerRaw({
      name: 'Laptop',
      assetClass: 'it_equipment',
      date: '2026-01-01',
      costMinor: 120000,
      lifeYears: 4,
      accountCode: 'FIXED_ASSETS_IT',
    });
    await postRaw(
      '2026-12-31',
      [
        { code: 'DEPRECIATION_EXPENSE', isDebit: true, base: 30000 },
        { code: 'ACCUM_DEPRECIATION_IT', isDebit: false, base: 30000 },
      ],
      { reason: 'Annual depreciation charge for FY2026' },
    );
    await migrateToLatest();

    const before = await db
      .selectFrom('fixed_asset_depreciation')
      .selectAll()
      .execute();
    expect(before).toHaveLength(1);

    // `.rejects.toThrow()` cannot be used here: better-sqlite3 is a native
    // addon shared process-wide across Jest test files, so a SqliteError
    // raised in one file fails `instanceof Error` in another and the matcher
    // reports "did not throw" for a statement the database really did abort.
    // The refusal is asserted on its message instead — see the helper.
    await expectDbRefusal(
      () =>
        db
          .updateTable('fixed_asset_depreciation')
          .set({ amount_minor: 1 })
          .where('fixed_asset_id', '=', laptop)
          .execute(),
      /append-only/,
    );
    await expectDbRefusal(
      () =>
        db
          .deleteFrom('fixed_asset_depreciation')
          .where('fixed_asset_id', '=', laptop)
          .execute(),
      /append-only/,
    );

    // The trigger did not merely throw: the row is untouched by both.
    expect(
      await db.selectFrom('fixed_asset_depreciation').selectAll().execute(),
    ).toEqual(before);
  });

  it('rewrites nothing in the ledger', async () => {
    await seedYear('FY2026', 2026);
    await registerRaw({
      name: 'Laptop',
      assetClass: 'it_equipment',
      date: '2026-01-01',
      costMinor: 120000,
      lifeYears: 4,
      accountCode: 'FIXED_ASSETS_IT',
    });
    await postRaw(
      '2026-12-31',
      [
        { code: 'DEPRECIATION_EXPENSE', isDebit: true, base: 30000 },
        { code: 'ACCUM_DEPRECIATION_IT', isDebit: false, base: 30000 },
      ],
      { reason: 'Annual depreciation charge for FY2026' },
    );

    const before = {
      vouchers: await db.selectFrom('voucher').selectAll().execute(),
      lines: await db.selectFrom('voucher_line').selectAll().execute(),
      assets: await db.selectFrom('fixed_asset').selectAll().execute(),
    };

    await migrateToLatest();

    expectRowsUnchanged(
      await db.selectFrom('voucher').selectAll().execute(),
      before.vouchers,
    );
    expectRowsUnchanged(
      await db.selectFrom('voucher_line').selectAll().execute(),
      before.lines,
    );
    expect(await db.selectFrom('fixed_asset').selectAll().execute()).toEqual(
      before.assets,
    );
  });

  it('is a no-op on a database with no fixed assets', async () => {
    await expect(migrateToLatest()).resolves.toBeUndefined();
    const tables = await sql<{
      name: string;
    }>`SELECT name FROM sqlite_master WHERE type='table' AND name='fixed_asset_depreciation'`.execute(
      db,
    );
    expect(tables.rows).toHaveLength(1);
    expect(await attribution()).toEqual([]);
  });
});

/**
 * Compare rows across a migration that ADDS columns. A later migration may add
 * a column to `voucher` (issue #211 adds the input-VAT entitlement provenance);
 * that changes the row SHAPE without rewriting any datum, which is exactly what
 * this test is about. So the comparison is made on the fields that existed when
 * the snapshot was taken, and every newly added field is asserted to be NULL —
 * which is the stronger statement: nothing was back-filled either.
 */
function expectRowsUnchanged(
  after: Record<string, unknown>[],
  before: Record<string, unknown>[],
): void {
  expect(after).toHaveLength(before.length);
  after.forEach((row, i) => {
    const original = before[i];
    const known = Object.fromEntries(
      Object.keys(original).map((k) => [k, row[k]]),
    );
    expect(known).toEqual(original);
    for (const [k, v] of Object.entries(row)) {
      if (!(k in original)) expect(v).toBeNull();
    }
  });
}
