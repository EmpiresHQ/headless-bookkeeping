import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import SqliteDb from 'better-sqlite3';
import { Database } from '../database/types';
import { migrations } from '../database/migrations';
import { GENESIS_HASH } from './posting/voucher-hash';

describe('Wave 2 DB constraints (G6)', () => {
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

  it('rejects duplicate account.code at the DB level', async () => {
    // The seed migration already inserted 'CASH'; try to insert it again.
    const promise = db
      .insertInto('account')
      .values({
        code: 'CASH',
        name: 'Duplicate Cash',
        type: 'asset',
        currency: null,
        parent_id: null,
        is_system: 0,
      })
      .execute();

    await expect(promise).rejects.toThrow();
  });

  it('rejects invalid account.type at the DB level', async () => {
    const promise = db
      .insertInto('account')
      .values({
        code: 'INVALID_TYPE_ACCOUNT',
        name: 'Invalid Type Account',
        type: 'invalid',
        currency: null,
        parent_id: null,
        is_system: 0,
      })
      .execute();

    await expect(promise).rejects.toThrow();
  });

  it('rejects duplicate voucher.voucher_number at the DB level', async () => {
    await db
      .insertInto('voucher')
      .values({
        voucher_number: 'V-001',
        tax_point_date: '2026-03-15',
        posted_at: null,
        previous_hash: GENESIS_HASH,
        reverses_id: null,
        corrects_object_type: null,
        corrects_object_id: null,
        reason: null,
      })
      .execute();

    const promise = db
      .insertInto('voucher')
      .values({
        voucher_number: 'V-001',
        tax_point_date: '2026-03-16',
        posted_at: null,
        previous_hash: GENESIS_HASH,
        reverses_id: null,
        corrects_object_type: null,
        corrects_object_id: null,
        reason: null,
      })
      .execute();

    await expect(promise).rejects.toThrow();
  });

  it('rejects voucher_line with non-existent voucher_id at the DB level', async () => {
    const promise = db
      .insertInto('voucher_line')
      .values({
        voucher_id: 99999,
        account_id: 1,
        amount: 10000,
        currency: 'EUR',
        base_amount: 10000,
        fx_rate: 1,
        vat_code: null,
        is_debit: 1,
      })
      .execute();

    await expect(promise).rejects.toThrow();
  });

  it('rejects voucher_line with non-existent account_id at the DB level', async () => {
    // Insert a valid voucher so voucher_id exists.
    const voucher = await db
      .insertInto('voucher')
      .values({
        voucher_number: 'V-002',
        tax_point_date: '2026-03-15',
        posted_at: null,
        previous_hash: GENESIS_HASH,
        reverses_id: null,
        corrects_object_type: null,
        corrects_object_id: null,
        reason: null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    const promise = db
      .insertInto('voucher_line')
      .values({
        voucher_id: voucher.id,
        account_id: 99999,
        amount: 10000,
        currency: 'EUR',
        base_amount: 10000,
        fx_rate: 1,
        vat_code: null,
        is_debit: 1,
      })
      .execute();

    await expect(promise).rejects.toThrow();
  });

  // ---- Per-line value constraints (Task H2) ----

  async function seedVoucherAndAccount(): Promise<{
    voucherId: number;
    accountId: number;
  }> {
    const v = await db
      .insertInto('voucher')
      .values({
        voucher_number: 'V-CONSTRAINT',
        tax_point_date: '2026-03-15',
        posted_at: 1740000000,
        previous_hash: GENESIS_HASH,
        reverses_id: null,
        corrects_object_type: null,
        corrects_object_id: null,
        reason: null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    const a = await db
      .selectFrom('account')
      .select('id')
      .where('code', '=', 'CASH')
      .executeTakeFirstOrThrow();
    return { voucherId: v.id, accountId: a.id };
  }

  interface LineInsert {
    voucher_id: number;
    account_id: number;
    amount: number;
    currency: string;
    base_amount: number;
    fx_rate: number;
    vat_code: string | null;
    is_debit: number;
  }

  function line(
    over: Partial<LineInsert>,
    ids: { voucherId: number; accountId: number },
  ): LineInsert {
    return {
      voucher_id: ids.voucherId,
      account_id: ids.accountId,
      amount: 10000,
      currency: 'EUR',
      base_amount: 10000,
      fx_rate: 1,
      vat_code: null,
      is_debit: 1,
      ...over,
    };
  }

  it('rejects amount <= 0', async () => {
    const ids = await seedVoucherAndAccount();
    await expect(
      db
        .insertInto('voucher_line')
        .values(line({ amount: 0 }, ids))
        .execute(),
    ).rejects.toThrow();
    await expect(
      db
        .insertInto('voucher_line')
        .values(line({ amount: -1 }, ids))
        .execute(),
    ).rejects.toThrow();
  });

  it('rejects base_amount <= 0', async () => {
    const ids = await seedVoucherAndAccount();
    await expect(
      db
        .insertInto('voucher_line')
        .values(line({ base_amount: 0 }, ids))
        .execute(),
    ).rejects.toThrow();
  });

  it('rejects fx_rate <= 0 (blocks the negative-rate attack)', async () => {
    const ids = await seedVoucherAndAccount();
    await expect(
      db
        .insertInto('voucher_line')
        .values(line({ fx_rate: 0 }, ids))
        .execute(),
    ).rejects.toThrow();
    await expect(
      db
        .insertInto('voucher_line')
        .values(line({ fx_rate: -1 }, ids))
        .execute(),
    ).rejects.toThrow();
  });

  it('rejects is_debit outside {0,1}', async () => {
    const ids = await seedVoucherAndAccount();
    await expect(
      db
        .insertInto('voucher_line')
        .values(line({ is_debit: 2 }, ids))
        .execute(),
    ).rejects.toThrow();
  });

  it('accepts a well-formed line', async () => {
    const ids = await seedVoucherAndAccount();
    await expect(
      db.insertInto('voucher_line').values(line({}, ids)).execute(),
    ).resolves.toBeDefined();
  });

  // ---- Posted-voucher immutability (Task H3) ----

  it('blocks UPDATE of a posted voucher', async () => {
    const { voucherId } = await seedVoucherAndAccount(); // posted_at is set
    await expect(
      db
        .updateTable('voucher')
        .set({ reason: 'tamper' })
        .where('id', '=', voucherId)
        .execute(),
    ).rejects.toThrow();
  });

  it('blocks DELETE of a posted voucher', async () => {
    const { voucherId } = await seedVoucherAndAccount();
    await expect(
      db.deleteFrom('voucher').where('id', '=', voucherId).execute(),
    ).rejects.toThrow();
  });

  it('blocks UPDATE/DELETE of a posted voucher line', async () => {
    const ids = await seedVoucherAndAccount();
    const ln = await db
      .insertInto('voucher_line')
      .values(line({}, ids))
      .returningAll()
      .executeTakeFirstOrThrow();
    await expect(
      db
        .updateTable('voucher_line')
        .set({ amount: 1 })
        .where('id', '=', ln.id)
        .execute(),
    ).rejects.toThrow();
    await expect(
      db.deleteFrom('voucher_line').where('id', '=', ln.id).execute(),
    ).rejects.toThrow();
  });

  it('ALLOWS updating an UNPOSTED voucher (Wave-3 Policy-hold draft path)', async () => {
    const draft = await db
      .insertInto('voucher')
      .values({
        voucher_number: 'V-DRAFT',
        tax_point_date: '2026-03-15',
        posted_at: null,
        previous_hash: GENESIS_HASH,
        reverses_id: null,
        corrects_object_type: null,
        corrects_object_id: null,
        reason: null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    // OLD.posted_at is NULL, so the trigger must not fire
    await expect(
      db
        .updateTable('voucher')
        .set({ posted_at: 1740000000 })
        .where('id', '=', draft.id)
        .execute(),
    ).resolves.toBeDefined();
  });

  // ---- Wave 3 table constraints ----

  it('rejects invalid expense.status at the DB level', async () => {
    const promise = db
      .insertInto('expense')
      .values({
        category: 'software',
        gross_amount: 10000,
        vat_amount: 2300,
        currency: 'EUR',
        tax_point_date: '2026-03-15',
        status: 'invalid_status',
        voucher_id: null,
        created_at: 1740000000,
        updated_at: 1740000000,
      })
      .execute();
    await expect(promise).rejects.toThrow();
  });

  it('accepts valid expense.status values', async () => {
    for (const status of ['draft', 'pending', 'posted', 'reversed']) {
      await expect(
        db
          .insertInto('expense')
          .values({
            category: 'software',
            gross_amount: 10000,
            vat_amount: 2300,
            currency: 'EUR',
            tax_point_date: '2026-03-15',
            status,
            voucher_id: null,
            created_at: 1740000000,
            updated_at: 1740000000,
          })
          .execute(),
      ).resolves.toBeDefined();
    }
  });

  it('rejects duplicate sales_invoice.invoice_number at the DB level', async () => {
    await db
      .insertInto('sales_invoice')
      .values({
        invoice_number: 'INV-DUP-001',
        gross_amount: 10000,
        vat_amount: 2300,
        currency: 'EUR',
        tax_point_date: '2026-03-15',
        status: 'draft',
        sent_at: null,
        voucher_id: null,
        created_at: 1740000000,
        updated_at: 1740000000,
      })
      .execute();

    const promise = db
      .insertInto('sales_invoice')
      .values({
        invoice_number: 'INV-DUP-001',
        gross_amount: 20000,
        vat_amount: 4600,
        currency: 'EUR',
        tax_point_date: '2026-03-16',
        status: 'draft',
        sent_at: null,
        voucher_id: null,
        created_at: 1740000000,
        updated_at: 1740000000,
      })
      .execute();

    await expect(promise).rejects.toThrow();
  });

  it('rejects invalid sales_invoice.status at the DB level', async () => {
    const promise = db
      .insertInto('sales_invoice')
      .values({
        invoice_number: 'INV-STATUS-001',
        gross_amount: 10000,
        vat_amount: 2300,
        currency: 'EUR',
        tax_point_date: '2026-03-15',
        status: 'invalid_status',
        sent_at: null,
        voucher_id: null,
        created_at: 1740000000,
        updated_at: 1740000000,
      })
      .execute();
    await expect(promise).rejects.toThrow();
  });

  it('accepts valid sales_invoice.status values', async () => {
    let counter = 0;
    for (const status of ['draft', 'pending', 'posted', 'reversed']) {
      await expect(
        db
          .insertInto('sales_invoice')
          .values({
            invoice_number: `INV-STATUS-OK-${counter++}`,
            gross_amount: 10000,
            vat_amount: 2300,
            currency: 'EUR',
            tax_point_date: '2026-03-15',
            status,
            sent_at: null,
            voucher_id: null,
            created_at: 1740000000,
            updated_at: 1740000000,
          })
          .execute(),
      ).resolves.toBeDefined();
    }
  });

  it('accepts a well-formed override record', async () => {
    await expect(
      db
        .insertInto('override')
        .values({
          business_object_type: 'expense',
          business_object_id: 1,
          rule_type: 'semantic',
          rule_name: 'vat_code_validity',
          reason: 'Supplier confirmed special treatment',
          created_by: 'test-user',
          created_at: 1740000000,
        })
        .execute(),
    ).resolves.toBeDefined();
  });
});
