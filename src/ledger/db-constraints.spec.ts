import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import SqliteDb from 'better-sqlite3';
import { Database } from '../database/types';
import { migrations } from '../database/migrations';

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
        previous_hash: null,
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
        previous_hash: null,
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
        previous_hash: null,
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
});
