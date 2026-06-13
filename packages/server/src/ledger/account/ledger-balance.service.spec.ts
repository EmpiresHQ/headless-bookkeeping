import { Test, TestingModule } from '@nestjs/testing';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import SqliteDb from 'better-sqlite3';
import { Database } from '../../database/types';
import { migrations } from '../../database/migrations';
import { LedgerBalanceService } from './ledger-balance.service';

describe('LedgerBalanceService.getLedgerNetForPeriod (integration)', () => {
  let db: Kysely<Database>;
  let service: LedgerBalanceService;

  async function insertVoucher(
    taxPointDate: string,
    lines: Array<{ code: string; isDebit: boolean; base: number }>,
  ): Promise<void> {
    const v = await db
      .insertInto('voucher')
      .values({
        voucher_number: `V-${taxPointDate}-${Math.random().toString(36).slice(2, 7)}`,
        tax_point_date: taxPointDate,
        posted_at: 1,
        previous_hash: null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    for (const l of lines) {
      const acc = await db
        .selectFrom('account')
        .select('id')
        .where('code', '=', l.code)
        .executeTakeFirstOrThrow();
      await db
        .insertInto('voucher_line')
        .values({
          voucher_id: v.id,
          account_id: acc.id,
          amount: l.base,
          currency: 'EUR',
          base_amount: l.base,
          fx_rate: 1,
          vat_code: null,
          is_debit: l.isDebit ? 1 : 0,
        })
        .execute();
    }
  }

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

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: KYSELY_MODULE_CONNECTION_TOKEN(), useValue: db },
        LedgerBalanceService,
      ],
    }).compile();
    service = module.get(LedgerBalanceService);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('sums only lines whose tax_point_date <= the period end', async () => {
    // In-year revenue.
    await insertVoucher('2026-03-01', [
      { code: 'BANK_EUR', isDebit: true, base: 10000 },
      { code: 'REVENUE', isDebit: false, base: 10000 },
    ]);
    // Next-year revenue — must NOT count for a 2026 close.
    await insertVoucher('2027-01-15', [
      { code: 'BANK_EUR', isDebit: true, base: 5000 },
      { code: 'REVENUE', isDebit: false, base: 5000 },
    ]);

    const rev = await service.getLedgerNetForPeriod(
      { codes: ['REVENUE'] },
      { endDate: '2026-12-31' },
      { creditPositive: true },
    );
    expect(rev).toBe(10000);

    const bank = await service.getLedgerNetForPeriod(
      { codes: ['BANK_EUR'] },
      { endDate: '2026-12-31' },
    );
    expect(bank).toBe(10000); // debit-positive, only the in-year voucher
  });

  it('honours a startDate lower bound for period flows (revenue within a year)', async () => {
    await insertVoucher('2025-06-01', [
      { code: 'BANK_EUR', isDebit: true, base: 7000 },
      { code: 'REVENUE', isDebit: false, base: 7000 },
    ]);
    await insertVoucher('2026-06-01', [
      { code: 'BANK_EUR', isDebit: true, base: 3000 },
      { code: 'REVENUE', isDebit: false, base: 3000 },
    ]);
    const rev2026 = await service.getLedgerNetForPeriod(
      { codes: ['REVENUE'] },
      { startDate: '2026-01-01', endDate: '2026-12-31' },
      { creditPositive: true },
    );
    expect(rev2026).toBe(3000);
  });
});

/**
 * Integration test for the consolidated signed-balance maths (real-DI, in-memory
 * SQLite). LedgerBalanceService is the ONE place the debit-positive sign
 * convention lives; these tests pin every flavour the three migrated call-sites
 * rely on:
 *   - AR outstanding (debit-normal, abs'd, per-voucher)
 *   - AP outstanding (credit-normal, abs'd, per-voucher)
 *   - distributable profits (RETAINED_EARNINGS + revenue/expense, credit-positive, ledger-wide)
 *   - VAT-control net (per-line signed contribution)
 *   - reversal / multi-line netting (the correctness trap)
 */
describe('LedgerBalanceService (integration)', () => {
  let db: Kysely<Database>;
  let service: LedgerBalanceService;
  let voucherCounter = 0;

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

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: KYSELY_MODULE_CONNECTION_TOKEN(), useValue: db },
        LedgerBalanceService,
      ],
    }).compile();

    service = module.get(LedgerBalanceService);
  });

  afterEach(async () => {
    await db.destroy();
  });

  // ── Helpers ───────────────────────────────────────────────────────────

  async function accountId(code: string): Promise<number> {
    const row = await db
      .selectFrom('account')
      .select('id')
      .where('code', '=', code)
      .executeTakeFirstOrThrow();
    return row.id;
  }

  async function postVoucher(
    lines: Array<{ code: string; base_amount: number; is_debit: 0 | 1 }>,
    opts: { reverses_id?: number } = {},
  ): Promise<number> {
    voucherCounter++;
    const voucher = await db
      .insertInto('voucher')
      .values({
        voucher_number: `V-2025-${String(voucherCounter).padStart(6, '0')}`,
        tax_point_date: '2025-01-10',
        posted_at: Math.floor(Date.now() / 1000),
        previous_hash: null,
        reverses_id: opts.reverses_id ?? null,
        corrects_object_type: null,
        corrects_object_id: null,
        reason: null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    for (const l of lines) {
      await db
        .insertInto('voucher_line')
        .values({
          voucher_id: voucher.id,
          account_id: await accountId(l.code),
          amount: l.base_amount,
          currency: 'EUR',
          base_amount: l.base_amount,
          fx_rate: 1,
          vat_code: null,
          is_debit: l.is_debit,
        })
        .execute();
    }
    return voucher.id;
  }

  // ── getVoucherNetBase: AR / AP outstanding (per-voucher, abs'd) ─────────

  it('AR outstanding: a sales-invoice voucher nets to its AR debit magnitude', async () => {
    // Dr AR 12500 / Cr REVENUE 10000 / Cr VAT_PAYABLE 2500
    const v = await postVoucher([
      { code: 'AR', base_amount: 12500, is_debit: 1 },
      { code: 'REVENUE', base_amount: 10000, is_debit: 0 },
      { code: 'VAT_PAYABLE', base_amount: 2500, is_debit: 0 },
    ]);
    expect(await service.getVoucherNetBase(v, ['AR', 'AP'])).toBe(12500);
  });

  it('AP outstanding: a bill voucher nets to its AP credit magnitude (abs)', async () => {
    // Dr EXPENSE 10000 / Dr VAT_RECEIVABLE 2500 / Cr AP 12500
    const v = await postVoucher([
      { code: 'EXPENSE_OTHER', base_amount: 10000, is_debit: 1 },
      { code: 'VAT_RECEIVABLE', base_amount: 2500, is_debit: 1 },
      { code: 'AP', base_amount: 12500, is_debit: 0 },
    ]);
    expect(await service.getVoucherNetBase(v, ['AR', 'AP'])).toBe(12500);
  });

  it('returns 0 when the voucher has no AR/AP lines', async () => {
    const v = await postVoucher([
      { code: 'REVENUE', base_amount: 10000, is_debit: 0 },
      { code: 'BANK_EUR', base_amount: 10000, is_debit: 1 },
    ]);
    expect(await service.getVoucherNetBase(v, ['AR', 'AP'])).toBe(0);
  });

  it('nets an AR debit against an AP credit on the same voucher to zero', async () => {
    // Intended contra/reclass netting (NOT a reversal): equal AR debit + AP
    // credit collapse to their true magnitude (0), not sum to 20000.
    const v = await postVoucher([
      { code: 'AR', base_amount: 10000, is_debit: 1 },
      { code: 'AP', base_amount: 10000, is_debit: 0 },
    ]);
    expect(await service.getVoucherNetBase(v, ['AR', 'AP'])).toBe(0);
  });

  // ── Reversal trap: a reversal voucher must NOT look already-matched ──────

  it('reversal of a sales invoice nets to its full AR magnitude, not zero (reversal trap)', async () => {
    // Original: Dr AR / Cr REVENUE / Cr VAT_PAYABLE.
    const original = await postVoucher([
      { code: 'AR', base_amount: 12500, is_debit: 1 },
      { code: 'REVENUE', base_amount: 10000, is_debit: 0 },
      { code: 'VAT_PAYABLE', base_amount: 2500, is_debit: 0 },
    ]);
    // Reversal mirrors every line with flipped is_debit (corrections.service):
    // Cr AR / Dr REVENUE / Dr VAT_PAYABLE.
    const reversal = await postVoucher(
      [
        { code: 'AR', base_amount: 12500, is_debit: 0 },
        { code: 'REVENUE', base_amount: 10000, is_debit: 1 },
        { code: 'VAT_PAYABLE', base_amount: 2500, is_debit: 1 },
      ],
      { reverses_id: original },
    );

    // The reversal voucher carries a SINGLE AR line (a credit). Netting must
    // therefore yield its full magnitude 12500 — NOT zero. A zero here would
    // make the reversal look fully matched / already-settled. (The original AR
    // and the reversal AR live on different vouchers, so they never net against
    // each other inside a per-voucher computation.)
    expect(await service.getVoucherNetBase(reversal, ['AR', 'AP'])).toBe(12500);
    expect(await service.getVoucherNetBase(original, ['AR', 'AP'])).toBe(12500);
  });

  // ── getLedgerNet: distributable profits (credit-positive, ledger-wide) ──

  it('distributable profits = RETAINED_EARNINGS + (revenue − expense), credit-positive', async () => {
    // Revenue 30000 (Cr), Expense 11000 (Dr) → net income 19000.
    await postVoucher([
      { code: 'AR', base_amount: 30000, is_debit: 1 },
      { code: 'REVENUE', base_amount: 30000, is_debit: 0 },
    ]);
    await postVoucher([
      { code: 'EXPENSE_OTHER', base_amount: 11000, is_debit: 1 },
      { code: 'AP', base_amount: 11000, is_debit: 0 },
    ]);
    // A prior dividend already debited RETAINED_EARNINGS by 4000.
    await postVoucher([
      { code: 'RETAINED_EARNINGS', base_amount: 4000, is_debit: 1 },
      { code: 'DIVIDEND_PAYABLE', base_amount: 4000, is_debit: 0 },
    ]);

    // distributable = RE(−4000) + revenue(30000) − expense(11000) = 15000
    const distributable = await service.getLedgerNet(
      { codes: ['RETAINED_EARNINGS'], types: ['revenue', 'expense'] },
      { creditPositive: true },
    );
    expect(distributable).toBe(15000);
  });

  it('getLedgerNet returns a negative figure for a loss (sign is meaningful)', async () => {
    await postVoucher([
      { code: 'EXPENSE_OTHER', base_amount: 5000, is_debit: 1 },
      { code: 'AP', base_amount: 5000, is_debit: 0 },
    ]);
    const distributable = await service.getLedgerNet(
      { codes: ['RETAINED_EARNINGS'], types: ['revenue', 'expense'] },
      { creditPositive: true },
    );
    expect(distributable).toBe(-5000);
  });

  it('getLedgerNet returns 0 for an empty filter', async () => {
    expect(await service.getLedgerNet({})).toBe(0);
  });

  // ── signedBaseAmount: the per-line VAT-control convention ───────────────

  it('signedBaseAmount: VAT_RECEIVABLE input VAT is debit-positive', () => {
    expect(service.signedBaseAmount({ is_debit: 1, base_amount: 2500 })).toBe(
      2500,
    );
    expect(service.signedBaseAmount({ is_debit: 0, base_amount: 2500 })).toBe(
      -2500,
    );
  });

  it('signedBaseAmount: VAT_PAYABLE output VAT is credit-positive', () => {
    expect(
      service.signedBaseAmount(
        { is_debit: 0, base_amount: 2500 },
        { creditPositive: true },
      ),
    ).toBe(2500);
    expect(
      service.signedBaseAmount(
        { is_debit: 1, base_amount: 2500 },
        { creditPositive: true },
      ),
    ).toBe(-2500);
  });
});
