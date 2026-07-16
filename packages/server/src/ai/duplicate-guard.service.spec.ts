import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import SqliteDb from 'better-sqlite3';
import { Database } from '../database/types';
import { migrations } from '../database/migrations';
import { DuplicateGuardService } from './duplicate-guard.service';

describe('DuplicateGuardService', () => {
  let db: Kysely<Database>;
  let guard: DuplicateGuardService;
  let supplierId: number;

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

    const supplier = await db
      .insertInto('entity')
      .values({
        role: 'supplier',
        country: 'IE',
        name: 'Test Supplier',
        goods_vs_services: null,
        created_at: Date.now(),
        updated_at: Date.now(),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    supplierId = supplier.id;

    guard = new DuplicateGuardService(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  async function seedExpense(opts: {
    supplierId: number;
    invoiceNo: string | null;
    gross: number;
    date: string;
    status: string;
  }) {
    return db
      .insertInto('expense')
      .values({
        document_id: null,
        supplier_id: opts.supplierId,
        category: 'general',
        gross_amount: opts.gross,
        vat_amount: 0,
        currency: 'EUR',
        tax_point_date: opts.date,
        status: opts.status,
        voucher_id: null,
        document_vat_marking: null,
        supplier_invoice_number: opts.invoiceNo,
        asset_name: null,
        asset_useful_life_years: null,
        asset_residual_value_minor: null,
        claimant_id: null,
        company_addressed_receipt: null,
        ai_confidence: null,
        ai_document_type: null,
        ai_kind: null,
        created_at: Date.now(),
        updated_at: Date.now(),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
  }

  it('Tier 1: same supplier + same invoice number blocks', async () => {
    await seedExpense({
      supplierId,
      invoiceNo: '2599',
      gross: 5200,
      date: '2026-07-15',
      status: 'posted',
    });

    const m = await guard.check({
      supplierId,
      supplierInvoiceNumber: '2599',
      grossAmount: 5200,
      taxPointDate: '2026-07-15',
    });

    expect(m?.tier).toBe(1);
    expect(m?.reason).toContain('possible duplicate of');
  });

  it('Tier 2: same supplier + gross + date within 7 days blocks (no/other numbers)', async () => {
    await seedExpense({
      supplierId,
      invoiceNo: null,
      gross: 5200,
      date: '2026-07-15',
      status: 'posted',
    });

    const m = await guard.check({
      supplierId,
      supplierInvoiceNumber: '28965',
      grossAmount: 5200,
      taxPointDate: '2026-07-15',
    });

    expect(m?.tier).toBe(2);
    expect(m?.reason).toContain('possible duplicate of');
  });

  it('flags (does not silently drop) two real invoices: same supplier+gross+date but different numbers', async () => {
    // Different printed numbers skip Tier 1 (which requires an exact match),
    // but same gross + date still trips Tier 2 — safe (one operator click)
    // rather than silently posting a possible duplicate.
    await seedExpense({
      supplierId,
      invoiceNo: '1000',
      gross: 5200,
      date: '2026-07-15',
      status: 'posted',
    });

    const m = await guard.check({
      supplierId,
      supplierInvoiceNumber: '1001',
      grossAmount: 5200,
      taxPointDate: '2026-07-15',
    });

    expect(m?.tier).toBe(2);
  });

  it('does NOT block a monthly recurring invoice 30 days apart', async () => {
    await seedExpense({
      supplierId,
      invoiceNo: null,
      gross: 5200,
      date: '2026-06-15',
      status: 'posted',
    });

    const m = await guard.check({
      supplierId,
      supplierInvoiceNumber: null,
      grossAmount: 5200,
      taxPointDate: '2026-07-15',
    });

    expect(m).toBeNull();
  });

  it('does NOT block when numbers differ AND gross/date differ', async () => {
    await seedExpense({
      supplierId,
      invoiceNo: '1000',
      gross: 5200,
      date: '2026-07-15',
      status: 'posted',
    });

    const m = await guard.check({
      supplierId,
      supplierInvoiceNumber: '1001',
      grossAmount: 999,
      taxPointDate: '2026-01-01',
    });

    expect(m).toBeNull();
  });

  it('ignores reversed expenses', async () => {
    await seedExpense({
      supplierId,
      invoiceNo: '2599',
      gross: 5200,
      date: '2026-07-15',
      status: 'reversed',
    });

    const m = await guard.check({
      supplierId,
      supplierInvoiceNumber: '2599',
      grossAmount: 5200,
      taxPointDate: '2026-07-15',
    });

    expect(m).toBeNull();
  });

  it('throws if supplierId is null (fail-closed, never silently pass)', async () => {
    await expect(
      guard.check({
        supplierId: null as any,
        supplierInvoiceNumber: null,
        grossAmount: 5200,
        taxPointDate: '2026-07-15',
      }),
    ).rejects.toThrow(
      'DuplicateGuardService.check requires a resolved supplierId',
    );
  });

  it('Tier 2: blocks at exactly -7 days (inclusive lower window edge)', async () => {
    await seedExpense({
      supplierId,
      invoiceNo: null,
      gross: 5200,
      date: '2026-07-08',
      status: 'posted',
    });

    const m = await guard.check({
      supplierId,
      supplierInvoiceNumber: null,
      grossAmount: 5200,
      taxPointDate: '2026-07-15',
    });

    expect(m?.tier).toBe(2);
  });

  it('Tier 2: does NOT block at -8 days (just outside window)', async () => {
    await seedExpense({
      supplierId,
      invoiceNo: null,
      gross: 5200,
      date: '2026-07-07',
      status: 'posted',
    });

    const m = await guard.check({
      supplierId,
      supplierInvoiceNumber: null,
      grossAmount: 5200,
      taxPointDate: '2026-07-15',
    });

    expect(m).toBeNull();
  });

  it('Tier 2: blocks across a June/July month boundary', async () => {
    await seedExpense({
      supplierId,
      invoiceNo: null,
      gross: 5200,
      date: '2026-06-27',
      status: 'posted',
    });

    const m = await guard.check({
      supplierId,
      supplierInvoiceNumber: null,
      grossAmount: 5200,
      taxPointDate: '2026-07-03',
    });

    expect(m?.tier).toBe(2);
  });
});
