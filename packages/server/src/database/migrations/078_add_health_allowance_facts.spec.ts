import { Kysely, SqliteDialect, sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import SqliteDb from 'better-sqlite3';
import { Database } from '../types';
import { migrations } from './index';
import { expectDbRefusal } from '../../../test/expect-db-refusal';

/**
 * Issue #212. The health eligibility facts arrive as columns and the migration
 * asserts NONE of them about the claims that were already there.
 *
 * That restraint is the point. A pre-existing health claim was classified by
 * the code that exempted any amount; back-filling it with a qualifying category
 * or a "documents exist" flag would launder that decision into a fact nobody
 * ever asserted, and the exempt figure would then look measured when it never
 * was. It stays NULL — not recorded — which is what the classification path
 * reads as "cannot be shown to qualify".
 */
it('adds the facts without inventing any, constrains them, and seeds the fringe-tax accounts', async () => {
  const db = new Kysely<Database>({
    dialect: new SqliteDialect({ database: new SqliteDb(':memory:') }),
  });
  try {
    const migrator = new Migrator({
      db,
      provider: { getMigrations: () => Promise.resolve(migrations) },
    });
    expect(
      (await migrator.migrateTo('077_add_input_vat_entitlement')).error,
    ).toBeUndefined();

    const claimant = await db
      .insertInto('entity')
      .values({
        role: 'employee',
        country: 'EE',
        name: 'Vana Töötaja',
        goods_vs_services: null,
        created_at: 1,
        updated_at: 1,
      } as never)
      .returning('id')
      .executeTakeFirstOrThrow();

    // The bug's own output: EUR 1000 booked entirely tax-free.
    await db
      .insertInto('allowance')
      .values({
        claimant_id: claimant.id,
        type: 'health',
        input_amount: 100000,
        gross_amount: 100000,
        tax_free_amount: 100000,
        taxable_amount: 0,
        period_start: '2026-02-01',
        status: 'posted',
        created_at: 1,
        updated_at: 1,
      } as never)
      .returning('id')
      .executeTakeFirstOrThrow();

    expect((await migrator.migrateToLatest()).error).toBeUndefined();

    const legacy = await db
      .selectFrom('allowance')
      .selectAll()
      .where('claimant_id', '=', claimant.id)
      .executeTakeFirstOrThrow();

    // Nothing was decided on its behalf …
    expect(legacy.health_category).toBeNull();
    expect(legacy.claimant_relation).toBeNull();
    expect(legacy.supporting_document_id).toBeNull();
    expect(legacy.supporting_document_ref).toBeNull();
    expect(legacy.provider_registration).toBeNull();
    expect(legacy.offered_to_all_employees).toBeNull();
    expect(legacy.exemption_basis).toBeNull();
    expect(legacy.limit_window).toBeNull();
    // … and it records no fringe tax, because none was ever computed for it.
    // That is a statement about the books, not a finding that none was owed:
    // the report flags a basis-less claim as unresolved for exactly that reason.
    expect(legacy.fringe_income_tax_amount).toBe(0);
    expect(legacy.fringe_social_tax_amount).toBe(0);
    // The posted amounts are untouched — the ledger is not rewritten.
    expect(legacy).toMatchObject({
      gross_amount: 100000,
      tax_free_amount: 100000,
      taxable_amount: 0,
      status: 'posted',
    });

    // ── The columns only accept meanings the classification understands ────
    const before = await db
      .selectFrom('allowance')
      .selectAll()
      .where('id', '=', legacy.id)
      .executeTakeFirstOrThrow();

    await expectDbRefusal(
      () =>
        db
          .updateTable('allowance')
          .set({ claimant_relation: 'sort_of_an_employee' })
          .where('id', '=', legacy.id)
          .execute(),
      /CHECK constraint failed/,
    );
    await expectDbRefusal(
      () =>
        db
          .updateTable('allowance')
          .set({ offered_to_all_employees: 7 })
          .where('id', '=', legacy.id)
          .execute(),
      /CHECK constraint failed/,
    );
    await expectDbRefusal(
      () =>
        db
          .updateTable('allowance')
          .set({ fringe_income_tax_amount: -1 })
          .where('id', '=', legacy.id)
          .execute(),
      /CHECK constraint failed/,
    );
    // Every refusal left the row exactly as it was.
    expect(
      await db
        .selectFrom('allowance')
        .selectAll()
        .where('id', '=', legacy.id)
        .executeTakeFirstOrThrow(),
    ).toEqual(before);

    // ── The fringe-benefit accounts exist, as system accounts ──────────────
    const accounts = await db
      .selectFrom('account')
      .selectAll()
      .where('code', 'in', [
        'EXPENSE_FRINGE_BENEFIT',
        'EXPENSE_FRINGE_BENEFIT_TAX',
        'FRINGE_BENEFIT_INCOME_TAX_PAYABLE',
        'SOCIAL_TAX_PAYABLE',
      ])
      .execute();
    expect(accounts).toHaveLength(4);
    expect(accounts.every((a) => a.is_system === 1)).toBe(true);
    expect(
      accounts
        .filter((a) => a.type === 'liability')
        .map((a) => a.code)
        .sort(),
    ).toEqual(['FRINGE_BENEFIT_INCOME_TAX_PAYABLE', 'SOCIAL_TAX_PAYABLE']);

    // ── And it rolls back cleanly ──────────────────────────────────────────
    expect(
      (await migrator.migrateTo('077_add_input_vat_entitlement')).error,
    ).toBeUndefined();
    const columns = await sql<{
      name: string;
    }>`PRAGMA table_info(allowance)`.execute(db);
    expect(columns.rows.map((c) => c.name)).not.toContain('health_category');
    expect(
      await db
        .selectFrom('account')
        .select('code')
        .where('code', '=', 'SOCIAL_TAX_PAYABLE')
        .executeTakeFirst(),
    ).toBeUndefined();
  } finally {
    await db.destroy();
  }
});
