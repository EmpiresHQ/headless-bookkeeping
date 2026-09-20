import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import SqliteDb from 'better-sqlite3';
import { Database } from '../types';
import { migrations } from './index';
import { expectDbRefusal } from '../../../test/expect-db-refusal';

/**
 * Issue #213. The advance tax facts arrive as columns, and the migration
 * asserts NOTHING about the receipts that were already there.
 *
 * That restraint is the point. A historical prepayment was posted GROSS by a
 * path that recorded no tax treatment at all. Back-filling it as a
 * `non_taxable_deposit` would turn the absence of a decision into a decision —
 * and it is exactly the wrong one whenever the money paid for a taxable
 * supply, because it would also lift the filing gate that exists to surface
 * those receipts. It stays `unresolved`: recorded, held, and visible.
 */
it('holds pre-existing advances as unresolved and constrains the new facts', async () => {
  const db = new Kysely<Database>({
    dialect: new SqliteDialect({ database: new SqliteDb(':memory:') }),
  });
  try {
    const migrator = new Migrator({
      db,
      provider: { getMigrations: () => Promise.resolve(migrations) },
    });
    expect(
      (await migrator.migrateTo('078_add_health_allowance_facts')).error,
    ).toBeUndefined();

    const voucher = await db
      .insertInto('voucher')
      .values({
        voucher_number: 'V-2025-000001',
        tax_point_date: '2025-06-10',
        posted_at: 1,
        previous_hash: null,
        reverses_id: null,
        corrects_object_type: null,
        corrects_object_id: null,
        reason: null,
      } as never)
      .returning('id')
      .executeTakeFirstOrThrow();

    // The pre-#213 shape: one gross advance, no tax fact anywhere.
    const advance = await db
      .insertInto('prepayment_advance')
      .values({
        voucher_id: voucher.id,
        kind: 'customer',
        account_code: 'CUSTOMER_PREPAYMENTS',
        entity_id: null,
        bank_transaction_id: null,
        original_base_amount: 12400,
        currency: 'EUR',
        needs_review: 0,
        origin: 'service',
        created_at: 1,
      } as never)
      .returning('id')
      .executeTakeFirstOrThrow();

    expect((await migrator.migrateToLatest()).error).toBeUndefined();

    const migrated = await db
      .selectFrom('prepayment_advance')
      .selectAll()
      .where('id', '=', advance.id)
      .executeTakeFirstOrThrow();

    // Held, not classified — and nothing about its VAT is invented.
    expect(migrated.tax_treatment).toBe('unresolved');
    expect(migrated.vat_code).toBeNull();
    expect(migrated.vat_rate_permille).toBeNull();
    expect(migrated.vat_base_amount).toBe(0);
    expect(migrated.supply_description).toBeNull();
    expect(migrated.advance_document_number).toBeNull();
    expect(migrated.advance_tax_point_date).toBeNull();
    expect(migrated.superseded_by_advance_id).toBeNull();
    // Its gross IS the prepayment leg: no VAT was ever split out of it.
    expect(migrated.gross_base_amount).toBe(12400);

    // An unknown treatment is refused by the database, not silently stored.
    await expectDbRefusal(
      () =>
        db
          .updateTable('prepayment_advance')
          .set({ tax_treatment: 'probably_fine' })
          .where('id', '=', advance.id)
          .execute(),
      /CHECK constraint failed/,
    );
    const afterRefusal = await db
      .selectFrom('prepayment_advance')
      .select('tax_treatment')
      .where('id', '=', advance.id)
      .executeTakeFirstOrThrow();
    expect(afterRefusal.tax_treatment).toBe('unresolved');

    // A refund cannot be recorded twice for the same bank line, whatever the
    // service layer does.
    const statement = await db
      .insertInto('bank_statement')
      .values({
        account_id: 1,
        start_date: '2025-06-01',
        end_date: '2025-06-30',
        uploaded_at: 1,
        file_path: null,
      } as never)
      .returning('id')
      .executeTakeFirstOrThrow();
    const bankTxn = await db
      .insertInto('bank_transaction')
      .values({
        statement_id: statement.id,
        transaction_date: '2025-06-20',
        description: 'Refund',
        amount: -12400,
        currency: 'EUR',
        status: 'open',
        created_at: 1,
      } as never)
      .returning('id')
      .executeTakeFirstOrThrow();

    const refund = {
      advance_id: advance.id,
      voucher_id: voucher.id,
      bank_transaction_id: bankTxn.id,
      net_base_amount: 10000,
      vat_base_amount: 2400,
      currency: 'EUR',
      credit_reference: 'KREEDIT-1',
      reason: 'Order cancelled',
      refund_date: '2025-06-20',
      created_at: 1,
    };
    await db
      .insertInto('prepayment_refund')
      .values(refund as never)
      .execute();
    await expectDbRefusal(
      () =>
        db
          .insertInto('prepayment_refund')
          .values(refund as never)
          .execute(),
      /UNIQUE constraint failed/,
    );
    const refunds = await db
      .selectFrom('prepayment_refund')
      .select('id')
      .execute();
    expect(refunds).toHaveLength(1);

    // And the allocation column defaults to "no advance VAT released", which
    // is what every pre-#213 draw-down did.
    const allocationDefault = await db
      .selectFrom('prepayment_allocation')
      .select('vat_base_amount')
      .executeTakeFirst();
    expect(allocationDefault).toBeUndefined();
  } finally {
    await db.destroy();
  }
});
