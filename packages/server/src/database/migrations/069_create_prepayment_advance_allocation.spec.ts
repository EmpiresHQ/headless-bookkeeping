import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import SqliteDb from 'better-sqlite3';
import { Database } from '../types';
import { migrations } from './index';

/**
 * Migration 069 backfill (issue #201): pre-existing prepayment vouchers become
 * OWNERLESS advance records, and pre-existing draw-downs are re-linked only
 * when the ledger itself confirms the machine-written marker. Anything it
 * cannot confirm leaves that kind's balances flagged UNVERIFIED rather than
 * guessed at.
 */
describe('Migration 069: prepayment advance + allocation backfill', () => {
  let db: Kysely<Database>;
  let voucherCounter = 0;

  /** Migrate up to the state just BEFORE 069, so legacy rows can be seeded. */
  beforeEach(async () => {
    voucherCounter = 0;
    db = new Kysely<Database>({
      dialect: new SqliteDialect({ database: new SqliteDb(':memory:') }),
    });
    const migrator = new Migrator({
      db,
      provider: { getMigrations: () => Promise.resolve(migrations) },
    });
    const { error } = await migrator.migrateTo(
      '068_add_submission_event_payload_id',
    );
    expect(error).toBeUndefined();
  });

  afterEach(() => db.destroy());

  async function runMigration(): Promise<void> {
    const migrator = new Migrator({
      db,
      provider: { getMigrations: () => Promise.resolve(migrations) },
    });
    const { error } = await migrator.migrateToLatest();
    expect(error).toBeUndefined();
  }

  async function insertVoucher(opts: {
    reason?: string | null;
    reversesId?: number | null;
  }): Promise<number> {
    voucherCounter++;
    const row = await db
      .insertInto('voucher')
      .values({
        voucher_number: `V-2025-${String(voucherCounter).padStart(6, '0')}`,
        tax_point_date: '2025-01-10',
        posted_at: Math.floor(Date.now() / 1000),
        previous_hash: null,
        reverses_id: opts.reversesId ?? null,
        corrects_object_type: null,
        corrects_object_id: null,
        reason: opts.reason ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return row.id;
  }

  async function insertLine(
    voucherId: number,
    code: string,
    baseAmount: number,
    isDebit: 0 | 1,
  ): Promise<void> {
    const account = await db
      .selectFrom('account')
      .select('id')
      .where('code', '=', code)
      .executeTakeFirstOrThrow();
    await db
      .insertInto('voucher_line')
      .values({
        voucher_id: voucherId,
        account_id: account.id,
        amount: baseAmount,
        currency: 'EUR',
        base_amount: baseAmount,
        fx_rate: 1,
        vat_code: null,
        is_debit: isDebit,
      })
      .execute();
  }

  /** Dr BANK_EUR / Cr CUSTOMER_PREPAYMENTS. */
  async function seedAdvance(amount: number): Promise<number> {
    const id = await insertVoucher({});
    await insertLine(id, 'BANK_EUR', amount, 1);
    await insertLine(id, 'CUSTOMER_PREPAYMENTS', amount, 0);
    return id;
  }

  /** Dr AR / Cr REVENUE. */
  async function seedInvoice(amount: number): Promise<number> {
    const id = await insertVoucher({});
    await insertLine(id, 'AR', amount, 1);
    await insertLine(id, 'REVENUE', amount, 0);
    return id;
  }

  /** Dr CUSTOMER_PREPAYMENTS / Cr AR, carrying the machine-written marker. */
  async function seedDrawDown(
    advanceId: number,
    invoiceId: number,
    amount: number,
    reason?: string,
  ): Promise<number> {
    const id = await insertVoucher({
      reason:
        reason ??
        `Draw-down of prepayment V-${advanceId} against invoice V-${invoiceId}`,
    });
    await insertLine(id, 'CUSTOMER_PREPAYMENTS', amount, 1);
    await insertLine(id, 'AR', amount, 0);
    return id;
  }

  /** A posted counter-voucher for `voucherId`. */
  async function seedReversal(
    voucherId: number,
    lines: [string, number, 0 | 1][],
  ): Promise<number> {
    const id = await insertVoucher({
      reversesId: voucherId,
      reason: 'reversal',
    });
    for (const [code, amount, isDebit] of lines) {
      await insertLine(id, code, amount, isDebit);
    }
    return id;
  }

  async function advances() {
    return db
      .selectFrom('prepayment_advance')
      .selectAll()
      .orderBy('id')
      .execute();
  }

  async function allocations() {
    return db
      .selectFrom('prepayment_allocation')
      .selectAll()
      .orderBy('id')
      .execute();
  }

  it('registers each advance voucher ownerless, and links a verified draw-down', async () => {
    const advanceId = await seedAdvance(10000);
    const invoiceId = await seedInvoice(10000);
    const drawDownId = await seedDrawDown(advanceId, invoiceId, 4000);

    await runMigration();

    const rows = await advances();
    expect(rows).toHaveLength(1);
    expect(rows[0].voucher_id).toBe(advanceId);
    expect(rows[0].kind).toBe('customer');
    expect(rows[0].original_base_amount).toBe(10000);
    // The counterparty is genuinely unknown: visible, not guessed.
    expect(rows[0].entity_id).toBeNull();
    expect(rows[0].needs_review).toBe(0);

    const links = await allocations();
    expect(links).toHaveLength(1);
    expect(links[0].advance_id).toBe(rows[0].id);
    expect(links[0].invoice_voucher_id).toBe(invoiceId);
    expect(links[0].allocation_voucher_id).toBe(drawDownId);
    expect(links[0].base_amount).toBe(4000);
  });

  it('nets a multi-leg advance into ONE record carrying its full amount', async () => {
    // One legal advance voucher whose prepayment credit arrives in two legs.
    const advanceId = await insertVoucher({});
    await insertLine(advanceId, 'BANK_EUR', 10000, 1);
    await insertLine(advanceId, 'CUSTOMER_PREPAYMENTS', 6000, 0);
    await insertLine(advanceId, 'CUSTOMER_PREPAYMENTS', 4000, 0);

    await runMigration();

    const rows = await advances();
    expect(rows).toHaveLength(1);
    expect(rows[0].original_base_amount).toBe(10000);
  });

  it('records a re-draw after a reversal instead of calling it an overdraw', async () => {
    // A = 100.00; D1 = 80.00 drawn, then reversed; D2 = 80.00 drawn again.
    const advanceId = await seedAdvance(10000);
    const invoiceId = await seedInvoice(20000);
    const firstDraw = await seedDrawDown(advanceId, invoiceId, 8000);
    await seedReversal(firstDraw, [
      ['CUSTOMER_PREPAYMENTS', 8000, 0],
      ['AR', 8000, 1],
    ]);
    const secondDraw = await seedDrawDown(advanceId, invoiceId, 8000);

    await runMigration();

    // Both draw-downs are recorded history; only the live one consumes credit,
    // so nothing is flagged.
    const rows = await advances();
    expect(rows).toHaveLength(1);
    expect(rows[0].needs_review).toBe(0);

    const links = await allocations();
    expect(links.map((l) => l.allocation_voucher_id).sort()).toEqual(
      [firstDraw, secondDraw].sort(),
    );
  });

  it('does not turn a reversed advance into a second advance record', async () => {
    const advanceId = await seedAdvance(10000);
    await seedReversal(advanceId, [
      ['CUSTOMER_PREPAYMENTS', 10000, 1],
      ['BANK_EUR', 10000, 0],
    ]);

    await runMigration();

    const rows = await advances();
    expect(rows).toHaveLength(1);
    expect(rows[0].voucher_id).toBe(advanceId);
    expect(rows[0].needs_review).toBe(0);
  });

  it('flags the kind when a draw-down carries no usable marker', async () => {
    const advanceId = await seedAdvance(10000);
    const invoiceId = await seedInvoice(10000);
    await seedDrawDown(advanceId, invoiceId, 4000, 'manual clearing');

    await runMigration();

    const rows = await advances();
    expect(rows[0].needs_review).toBe(1);
    await expect(allocations()).resolves.toEqual([]);
  });

  it('refuses a marker whose clearing voucher is not the expected shape', async () => {
    const advanceId = await seedAdvance(10000);
    const invoiceId = await seedInvoice(10000);
    // Same marker, but a third leg: not the two-legged clearing pair.
    const drawDownId = await insertVoucher({
      reason: `Draw-down of prepayment V-${advanceId} against invoice V-${invoiceId}`,
    });
    await insertLine(drawDownId, 'CUSTOMER_PREPAYMENTS', 4000, 1);
    await insertLine(drawDownId, 'AR', 3000, 0);
    await insertLine(drawDownId, 'REVENUE', 1000, 0);

    await runMigration();

    const rows = await advances();
    expect(rows[0].needs_review).toBe(1);
    await expect(allocations()).resolves.toEqual([]);
  });

  it('refuses a marker naming an advance of the wrong kind', async () => {
    const advanceId = await seedAdvance(10000);
    const invoiceId = await seedInvoice(10000);
    // A supplier-side clearing voucher claiming a customer advance.
    const drawDownId = await insertVoucher({
      reason: `Draw-down of prepayment V-${advanceId} against invoice V-${invoiceId}`,
    });
    await insertLine(drawDownId, 'AP', 4000, 1);
    await insertLine(drawDownId, 'SUPPLIER_PREPAYMENTS', 4000, 0);

    await runMigration();

    await expect(allocations()).resolves.toEqual([]);
    const rows = await advances();
    // The SUPPLIER side is the one that can no longer be derived.
    expect(rows.find((r) => r.kind === 'customer')!.needs_review).toBe(0);
  });

  it('flags the kind when a draw-down exceeds what is left of its advance', async () => {
    const advanceId = await seedAdvance(5000);
    const invoiceId = await seedInvoice(10000);
    await seedDrawDown(advanceId, invoiceId, 9000);

    await runMigration();

    const rows = await advances();
    expect(rows[0].needs_review).toBe(1);
    await expect(allocations()).resolves.toEqual([]);
  });

  it('is a no-op on a ledger with no prepayments', async () => {
    await seedInvoice(10000);

    await runMigration();

    await expect(advances()).resolves.toEqual([]);
    await expect(allocations()).resolves.toEqual([]);
  });
});
