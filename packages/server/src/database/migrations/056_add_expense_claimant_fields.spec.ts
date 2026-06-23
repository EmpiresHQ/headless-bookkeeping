import { Kysely, SqliteDialect, sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import SqliteDb from 'better-sqlite3';
import { Database } from '../types';
import { migrations } from './index';

describe('Migration 056: expense.claimant_id + expense.company_addressed_receipt', () => {
  let db: Kysely<Database>;

  beforeEach(async () => {
    db = new Kysely<Database>({
      dialect: new SqliteDialect({ database: new SqliteDb(':memory:') }),
    });
    const migrator = new Migrator({
      db,
      provider: { getMigrations: () => Promise.resolve(migrations) },
    });
    const { error } = await migrator.migrateToLatest();
    expect(error).toBeUndefined();
  });

  afterEach(() => db.destroy());

  it('adds nullable claimant_id column to expense', async () => {
    const now = Math.floor(Date.now() / 1000);
    // Insert expense with claimant_id = null (default)
    const row = await db
      .insertInto('expense')
      .values({
        supplier_id: null,
        category: 'meals',
        gross_amount: 1000,
        vat_amount: 0,
        currency: 'EUR',
        tax_point_date: '2026-06-01',
        status: 'draft',
        voucher_id: null,
        document_id: null,
        created_at: now,
        updated_at: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    expect(row.claimant_id).toBeNull();
  });

  it('enforces FK on claimant_id — rejects non-existent entity id', async () => {
    const now = Math.floor(Date.now() / 1000);
    await expect(
      db
        .insertInto('expense')
        .values({
          supplier_id: null,
          category: 'meals',
          gross_amount: 1000,
          vat_amount: 0,
          currency: 'EUR',
          tax_point_date: '2026-06-01',
          status: 'draft',
          voucher_id: null,
          document_id: null,
          claimant_id: 99999,
          created_at: now,
          updated_at: now,
        })
        .execute(),
    ).rejects.toThrow();
  });

  it('accepts a valid claimant_id FK pointing at an existing entity', async () => {
    const now = Math.floor(Date.now() / 1000);
    const entity = await db
      .insertInto('entity')
      .values({
        role: 'employee',
        country: 'EE',
        name: 'Alice Tamm',
        goods_vs_services: null,
        created_at: now,
        updated_at: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    const row = await db
      .insertInto('expense')
      .values({
        supplier_id: null,
        category: 'meals',
        gross_amount: 1200,
        vat_amount: 200,
        currency: 'EUR',
        tax_point_date: '2026-06-01',
        status: 'draft',
        voucher_id: null,
        document_id: null,
        claimant_id: entity.id,
        created_at: now,
        updated_at: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    expect(row.claimant_id).toBe(entity.id);
  });

  it('company_addressed_receipt accepts 0, 1, and null', async () => {
    const now = Math.floor(Date.now() / 1000);

    const rowNull = await db
      .insertInto('expense')
      .values({
        supplier_id: null,
        category: 'meals',
        gross_amount: 1000,
        vat_amount: 0,
        currency: 'EUR',
        tax_point_date: '2026-06-01',
        status: 'draft',
        voucher_id: null,
        document_id: null,
        company_addressed_receipt: null,
        created_at: now,
        updated_at: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    expect(rowNull.company_addressed_receipt).toBeNull();

    const rowFalse = await db
      .insertInto('expense')
      .values({
        supplier_id: null,
        category: 'meals',
        gross_amount: 1000,
        vat_amount: 0,
        currency: 'EUR',
        tax_point_date: '2026-06-01',
        status: 'draft',
        voucher_id: null,
        document_id: null,
        company_addressed_receipt: 0,
        created_at: now,
        updated_at: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    expect(rowFalse.company_addressed_receipt).toBe(0);

    const rowTrue = await db
      .insertInto('expense')
      .values({
        supplier_id: null,
        category: 'meals',
        gross_amount: 1000,
        vat_amount: 0,
        currency: 'EUR',
        tax_point_date: '2026-06-01',
        status: 'draft',
        voucher_id: null,
        document_id: null,
        company_addressed_receipt: 1,
        created_at: now,
        updated_at: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    expect(rowTrue.company_addressed_receipt).toBe(1);
  });

  it('DOWN migration removes both columns', async () => {
    // Roll back to just before 056 (i.e. undo 056 and everything after it).
    // Using migrateTo by name keeps this robust to migrations added after 057
    // (e.g. 058+), unlike a hard-coded number of single migrateDown() steps.
    const migrator = new Migrator({
      db,
      provider: { getMigrations: () => Promise.resolve(migrations) },
    });
    const { error } = await migrator.migrateTo('055_add_document_claimant_id');
    expect(error).toBeUndefined();

    // Use PRAGMA table_info to confirm the columns are no longer present.
    const result = await sql<{
      name: string;
    }>`PRAGMA table_info(expense)`.execute(db);
    const colNames = result.rows.map((r) => r.name);
    expect(colNames).not.toContain('claimant_id');
    expect(colNames).not.toContain('company_addressed_receipt');
  });
});
