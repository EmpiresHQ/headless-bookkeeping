import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import SqliteDb from 'better-sqlite3';
import { Database } from '../types';
import { migrations } from './index';
import { expectDbRefusal } from '../../../test/expect-db-refusal';

/**
 * Issue #209. The place-of-supply facts arrive as columns, and the migration
 * asserts nothing about the rows that were already there: a pre-existing
 * customer's tax status stays NULL (unknown — NOT "consumer"), and a
 * pre-existing invoice keeps the residual general rule it was always treated
 * under. A mass assumption at migration time is exactly what would put
 * unfounded figures on a return.
 */
it('adds the facts without assuming any, constrains their values, and rolls back cleanly', async () => {
  const db = new Kysely<Database>({
    dialect: new SqliteDialect({ database: new SqliteDb(':memory:') }),
  });
  try {
    const migrator = new Migrator({
      db,
      provider: { getMigrations: () => Promise.resolve(migrations) },
    });
    expect(
      (await migrator.migrateTo('075_create_fixed_asset_depreciation')).error,
    ).toBeUndefined();

    // A customer and an invoice that predate the new facts.
    const legacyCustomer = await db
      .insertInto('entity')
      .values({
        role: 'customer',
        country: 'FI',
        name: 'Vanha Oy',
        goods_vs_services: 'services',
        created_at: 1,
        updated_at: 1,
      } as never)
      .returning('id')
      .executeTakeFirstOrThrow();
    await db
      .insertInto('sales_invoice')
      .values({
        customer_id: legacyCustomer.id,
        invoice_number: 'INV-LEGACY-1',
        gross_amount: 10000,
        vat_amount: 0,
        currency: 'EUR',
        tax_point_date: '2026-01-15',
        status: 'posted',
        created_at: 1,
        updated_at: 1,
      } as never)
      .execute();

    expect((await migrator.migrateToLatest()).error).toBeUndefined();

    // The customer's status is UNKNOWN, recorded as such. Nothing decided it.
    const customer = await db
      .selectFrom('entity')
      .selectAll()
      .where('id', '=', legacyCustomer.id)
      .executeTakeFirstOrThrow();
    expect(customer.tax_status).toBeNull();

    const invoice = await db
      .selectFrom('sales_invoice')
      .selectAll()
      .where('invoice_number', '=', 'INV-LEGACY-1')
      .executeTakeFirstOrThrow();
    // Supply type unrecorded; place-of-supply rule is the residual general one.
    expect(invoice.supply_type).toBeNull();
    expect(invoice.service_place_rule).toBe('general');
    // …and the invoice is otherwise untouched.
    expect(invoice).toMatchObject({
      gross_amount: 10000,
      vat_amount: 0,
      status: 'posted',
    });

    // ── The columns only accept meanings the plugins understand ────────────
    const before = await db
      .selectFrom('entity')
      .selectAll()
      .where('id', '=', legacyCustomer.id)
      .executeTakeFirstOrThrow();
    await expectDbRefusal(
      () =>
        db
          .updateTable('entity')
          .set({ tax_status: 'probably_a_business' })
          .where('id', '=', legacyCustomer.id)
          .execute(),
      /CHECK constraint failed/,
    );
    expect(
      await db
        .selectFrom('entity')
        .selectAll()
        .where('id', '=', legacyCustomer.id)
        .executeTakeFirstOrThrow(),
    ).toEqual(before);

    const invoiceBefore = await db
      .selectFrom('sales_invoice')
      .selectAll()
      .where('invoice_number', '=', 'INV-LEGACY-1')
      .executeTakeFirstOrThrow();
    await expectDbRefusal(
      () =>
        db
          .updateTable('sales_invoice')
          .set({ service_place_rule: 'made_up_rule' })
          .where('invoice_number', '=', 'INV-LEGACY-1')
          .execute(),
      /CHECK constraint failed/,
    );
    await expectDbRefusal(
      () =>
        db
          .updateTable('sales_invoice')
          .set({ supply_type: 'vibes' })
          .where('invoice_number', '=', 'INV-LEGACY-1')
          .execute(),
      /CHECK constraint failed/,
    );
    expect(
      await db
        .selectFrom('sales_invoice')
        .selectAll()
        .where('invoice_number', '=', 'INV-LEGACY-1')
        .executeTakeFirstOrThrow(),
    ).toEqual(invoiceBefore);

    // The values the code does use are accepted.
    await db
      .updateTable('entity')
      .set({ tax_status: 'taxable_business' })
      .where('id', '=', legacyCustomer.id)
      .execute();
    await db
      .updateTable('sales_invoice')
      .set({
        supply_type: 'services',
        service_place_rule: 'immovable_property',
      })
      .where('invoice_number', '=', 'INV-LEGACY-1')
      .execute();

    // ── Rollback leaves the pre-076 shape and the original data ────────────
    expect(
      (await migrator.migrateTo('075_create_fixed_asset_depreciation')).error,
    ).toBeUndefined();
    const rolledBack = await db
      .selectFrom('sales_invoice')
      .selectAll()
      .where('invoice_number', '=', 'INV-LEGACY-1')
      .executeTakeFirstOrThrow();
    expect(rolledBack).not.toHaveProperty('supply_type');
    expect(rolledBack).not.toHaveProperty('service_place_rule');
    expect(rolledBack.gross_amount).toBe(10000);
    expect(
      await db
        .selectFrom('entity')
        .selectAll()
        .where('id', '=', legacyCustomer.id)
        .executeTakeFirstOrThrow(),
    ).not.toHaveProperty('tax_status');
  } finally {
    await db.destroy();
  }
});
