import { Test, TestingModule } from '@nestjs/testing';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import SqliteDb from 'better-sqlite3';
import { Database } from '../database/types';
import { migrations } from '../database/migrations';
import { AccountService } from '../ledger/account/account.service';
import { LedgerValidationService } from '../ledger/validation/ledger-validation.service';
import { PostingService } from '../ledger/posting/posting.service';
import { PeriodLockService } from '../reporting-periods/period-lock.service';
import { BankTransactionRepository } from '../bank/bank-transaction.repository';
import { BankStatementService } from '../bank/bank-statement.service';
import { OrganizationService } from '../organization/organization.service';
import { NullCountryPlugin } from '../plugins/null-country.plugin';
import { EstoniaCountryPlugin } from '../plugins/estonia-country.plugin';
import { PluginLoader } from '../plugins/plugin-loader.service';
import { CurrencyService } from '../currency/currency.service';
import { CountryPlugin } from '../plugins/country-plugin.interface';
import { PrepaymentService } from './prepayment.service';

/**
 * Integration test for prepayment creation and draw-down.
 * Uses real SQLite in-memory with full migrations (real-DI test, G2 gate).
 */
describe('PrepaymentService (integration)', () => {
  let db: Kysely<Database>;
  let prepaymentService: PrepaymentService;
  let bankStatementService: BankStatementService;
  let _postingService: PostingService;
  let voucherCounter = 0;

  beforeEach(async () => {
    db = new Kysely<Database>({
      dialect: new SqliteDialect({ database: new SqliteDb(':memory:') }),
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
        AccountService,
        LedgerValidationService,
        PostingService,
        PeriodLockService,
        BankTransactionRepository,
        BankStatementService,
        OrganizationService,
        NullCountryPlugin,
        EstoniaCountryPlugin,
        PluginLoader,
        CurrencyService,
        PrepaymentService,
      ],
    }).compile();

    prepaymentService = module.get(PrepaymentService);
    bankStatementService = module.get(BankStatementService);
    _postingService = module.get(PostingService);
  });

  afterEach(async () => {
    await db.destroy();
  });

  // ── Helpers ──────────────────────────────────────────────────────────

  async function seedBankTransaction(amount: number, status = 'open') {
    const stmt = await bankStatementService.createStatement({
      account_code: 'BANK_EUR',
      start_date: '2025-01-01',
      end_date: '2025-01-31',
      transactions: [
        {
          transaction_date: '2025-01-15',
          description:
            amount > 0 ? 'Customer payment received' : 'Supplier payment sent',
          amount,
          currency: 'EUR',
          status: status as 'open' | 'prepayment',
        },
      ],
    });
    return stmt.transactions[0];
  }

  async function seedSalesInvoiceVoucher(
    grossCents: number,
    taxPointDate: string,
  ): Promise<number> {
    const now = Math.floor(Date.now() / 1000);
    voucherCounter++;

    const voucher = await db
      .insertInto('voucher')
      .values({
        voucher_number: `V-2024-${String(voucherCounter).padStart(6, '0')}`,
        tax_point_date: taxPointDate,
        posted_at: now,
        previous_hash: null,
        reverses_id: null,
        corrects_object_type: null,
        corrects_object_id: null,
        reason: null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    const arAccount = await db
      .selectFrom('account')
      .select('id')
      .where('code', '=', 'AR')
      .executeTakeFirstOrThrow();

    const revenueAccount = await db
      .selectFrom('account')
      .select('id')
      .where('code', '=', 'REVENUE')
      .executeTakeFirstOrThrow();

    await db
      .insertInto('voucher_line')
      .values([
        {
          voucher_id: voucher.id,
          account_id: arAccount.id,
          amount: grossCents,
          currency: 'EUR',
          base_amount: grossCents,
          fx_rate: 1,
          vat_code: null,
          is_debit: 1,
        },
        {
          voucher_id: voucher.id,
          account_id: revenueAccount.id,
          amount: grossCents,
          currency: 'EUR',
          base_amount: grossCents,
          fx_rate: 1,
          vat_code: null,
          is_debit: 0,
        },
      ])
      .execute();

    return voucher.id;
  }

  async function seedExpenseVoucher(
    grossCents: number,
    taxPointDate: string,
  ): Promise<number> {
    const now = Math.floor(Date.now() / 1000);
    voucherCounter++;

    const voucher = await db
      .insertInto('voucher')
      .values({
        voucher_number: `V-2024-${String(voucherCounter).padStart(6, '0')}`,
        tax_point_date: taxPointDate,
        posted_at: now,
        previous_hash: null,
        reverses_id: null,
        corrects_object_type: null,
        corrects_object_id: null,
        reason: null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    const apAccount = await db
      .selectFrom('account')
      .select('id')
      .where('code', '=', 'AP')
      .executeTakeFirstOrThrow();

    const expenseAccount = await db
      .selectFrom('account')
      .select('id')
      .where('code', '=', 'EXPENSE_SOFTWARE')
      .executeTakeFirstOrThrow();

    await db
      .insertInto('voucher_line')
      .values([
        {
          voucher_id: voucher.id,
          account_id: expenseAccount.id,
          amount: grossCents,
          currency: 'EUR',
          base_amount: grossCents,
          fx_rate: 1,
          vat_code: null,
          is_debit: 1,
        },
        {
          voucher_id: voucher.id,
          account_id: apAccount.id,
          amount: grossCents,
          currency: 'EUR',
          base_amount: grossCents,
          fx_rate: 1,
          vat_code: null,
          is_debit: 0,
        },
      ])
      .execute();

    return voucher.id;
  }

  /**
   * Seed a sales-invoice (AR) voucher booked in a FOREIGN currency, with the
   * AR/revenue lines carrying base_amount = converted base value at `fxRate`.
   * Mirrors how SalesInvoicesService.generateDraftVoucher books the AR line
   * (currency = invoice currency, base_amount = round(gross * fxRate)).
   */
  async function seedForeignSalesInvoiceVoucher(
    grossCents: number,
    currency: string,
    fxRate: number,
    taxPointDate: string,
  ): Promise<{ voucherId: number; arBase: number }> {
    const now = Math.floor(Date.now() / 1000);
    voucherCounter++;
    const arBase = Math.round(grossCents * fxRate);

    const voucher = await db
      .insertInto('voucher')
      .values({
        voucher_number: `V-2024-${String(voucherCounter).padStart(6, '0')}`,
        tax_point_date: taxPointDate,
        posted_at: now,
        previous_hash: null,
        reverses_id: null,
        corrects_object_type: null,
        corrects_object_id: null,
        reason: null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    const arAccount = await db
      .selectFrom('account')
      .select('id')
      .where('code', '=', 'AR')
      .executeTakeFirstOrThrow();
    const revenueAccount = await db
      .selectFrom('account')
      .select('id')
      .where('code', '=', 'REVENUE')
      .executeTakeFirstOrThrow();

    await db
      .insertInto('voucher_line')
      .values([
        {
          voucher_id: voucher.id,
          account_id: arAccount.id,
          amount: grossCents,
          currency,
          base_amount: arBase,
          fx_rate: fxRate,
          vat_code: null,
          is_debit: 1,
        },
        {
          voucher_id: voucher.id,
          account_id: revenueAccount.id,
          amount: grossCents,
          currency,
          base_amount: arBase,
          fx_rate: fxRate,
          vat_code: null,
          is_debit: 0,
        },
      ])
      .execute();

    return { voucherId: voucher.id, arBase };
  }

  /**
   * Seed a customer-prepayment voucher whose CUSTOMER_PREPAYMENTS line carries
   * a NON-base currency (e.g. USD). This reproduces the cross-currency state
   * the draw-down fix must defend against: the relief must be booked in BASE
   * currency, not blindly inherit the prepayment line's stored currency.
   */
  async function seedForeignCustomerPrepaymentVoucher(
    baseCents: number,
    currency: string,
    taxPointDate: string,
  ): Promise<number> {
    const now = Math.floor(Date.now() / 1000);
    voucherCounter++;

    const voucher = await db
      .insertInto('voucher')
      .values({
        voucher_number: `V-2024-${String(voucherCounter).padStart(6, '0')}`,
        tax_point_date: taxPointDate,
        posted_at: now,
        previous_hash: null,
        reverses_id: null,
        corrects_object_type: null,
        corrects_object_id: null,
        reason: null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    const bankAccount = await db
      .selectFrom('account')
      .select('id')
      .where('code', '=', 'BANK_EUR')
      .executeTakeFirstOrThrow();
    const prepayAccount = await db
      .selectFrom('account')
      .select('id')
      .where('code', '=', 'CUSTOMER_PREPAYMENTS')
      .executeTakeFirstOrThrow();

    await db
      .insertInto('voucher_line')
      .values([
        {
          voucher_id: voucher.id,
          account_id: bankAccount.id,
          amount: baseCents,
          currency: 'EUR',
          base_amount: baseCents,
          fx_rate: 1,
          vat_code: null,
          is_debit: 1,
        },
        {
          voucher_id: voucher.id,
          account_id: prepayAccount.id,
          amount: baseCents,
          currency,
          base_amount: baseCents,
          fx_rate: 1,
          vat_code: null,
          is_debit: 0,
        },
      ])
      .execute();

    return voucher.id;
  }

  // ── Customer prepayment creation ───────────────────────────────────

  describe('createCustomerPrepayment', () => {
    it('posts Dr BANK_EUR / Cr CUSTOMER_PREPAYMENTS for an incoming payment', async () => {
      const txn = await seedBankTransaction(50000);

      const voucher = await prepaymentService.createCustomerPrepayment(txn.id);

      expect(voucher.id).toBeGreaterThan(0);
      expect(voucher.lines).toHaveLength(2);

      const debitLine = voucher.lines.find((l) => l.is_debit);
      const creditLine = voucher.lines.find((l) => !l.is_debit);

      expect(debitLine).toBeDefined();
      expect(creditLine).toBeDefined();

      const bankAccount = await db
        .selectFrom('account')
        .select('code')
        .where('id', '=', debitLine!.account_id)
        .executeTakeFirstOrThrow();
      expect(bankAccount.code).toBe('BANK_EUR');

      const prepayAccount = await db
        .selectFrom('account')
        .select('code')
        .where('id', '=', creditLine!.account_id)
        .executeTakeFirstOrThrow();
      expect(prepayAccount.code).toBe('CUSTOMER_PREPAYMENTS');

      expect(debitLine!.base_amount).toBe(50000);
      expect(creditLine!.base_amount).toBe(50000);
      expect(debitLine!.fx_rate).toBe(1.0);
      expect(creditLine!.fx_rate).toBe(1.0);
    });

    it('updates the bank transaction status to prepayment', async () => {
      const txn = await seedBankTransaction(30000);

      await prepaymentService.createCustomerPrepayment(txn.id);

      const updated = await db
        .selectFrom('bank_transaction')
        .select('status')
        .where('id', '=', txn.id)
        .executeTakeFirstOrThrow();
      expect(updated.status).toBe('prepayment');
    });

    it('rejects a non-open transaction', async () => {
      const txn = await seedBankTransaction(20000, 'prepayment');

      await expect(
        prepaymentService.createCustomerPrepayment(txn.id),
      ).rejects.toThrow('not open');
    });

    it('rejects a negative (outgoing) amount', async () => {
      const txn = await seedBankTransaction(-10000);

      await expect(
        prepaymentService.createCustomerPrepayment(txn.id),
      ).rejects.toThrow('positive');
    });

    it('rejects a non-existent transaction', async () => {
      await expect(
        prepaymentService.createCustomerPrepayment(99999),
      ).rejects.toThrow('not found');
    });
  });

  // ── Supplier prepayment creation ───────────────────────────────────

  describe('createSupplierPrepayment', () => {
    it('posts Dr SUPPLIER_PREPAYMENTS / Cr BANK_EUR for an outgoing payment', async () => {
      const txn = await seedBankTransaction(-40000);

      const voucher = await prepaymentService.createSupplierPrepayment(txn.id);

      expect(voucher.id).toBeGreaterThan(0);
      expect(voucher.lines).toHaveLength(2);

      const debitLine = voucher.lines.find((l) => l.is_debit);
      const creditLine = voucher.lines.find((l) => !l.is_debit);

      expect(debitLine).toBeDefined();
      expect(creditLine).toBeDefined();

      const prepayAccount = await db
        .selectFrom('account')
        .select('code')
        .where('id', '=', debitLine!.account_id)
        .executeTakeFirstOrThrow();
      expect(prepayAccount.code).toBe('SUPPLIER_PREPAYMENTS');

      const bankAccount = await db
        .selectFrom('account')
        .select('code')
        .where('id', '=', creditLine!.account_id)
        .executeTakeFirstOrThrow();
      expect(bankAccount.code).toBe('BANK_EUR');

      expect(debitLine!.base_amount).toBe(40000);
      expect(creditLine!.base_amount).toBe(40000);
    });

    it('rejects a positive (incoming) amount', async () => {
      const txn = await seedBankTransaction(15000);

      await expect(
        prepaymentService.createSupplierPrepayment(txn.id),
      ).rejects.toThrow('negative');
    });
  });

  // ── Dispatch: createPrepaymentFromTransaction ──────────────────────

  describe('createPrepaymentFromTransaction', () => {
    it('creates customer prepayment for positive amount', async () => {
      const txn = await seedBankTransaction(25000);

      const voucher = await prepaymentService.createPrepaymentFromTransaction(
        txn.id,
      );

      const creditAccount = await db
        .selectFrom('account')
        .select('code')
        .innerJoin('voucher_line', 'voucher_line.account_id', 'account.id')
        .where('voucher_line.voucher_id', '=', voucher.id)
        .where('voucher_line.is_debit', '=', 0)
        .executeTakeFirstOrThrow();
      expect(creditAccount.code).toBe('CUSTOMER_PREPAYMENTS');
    });

    it('creates supplier prepayment for negative amount', async () => {
      const txn = await seedBankTransaction(-25000);

      const voucher = await prepaymentService.createPrepaymentFromTransaction(
        txn.id,
      );

      const debitAccount = await db
        .selectFrom('account')
        .select('code')
        .innerJoin('voucher_line', 'voucher_line.account_id', 'account.id')
        .where('voucher_line.voucher_id', '=', voucher.id)
        .where('voucher_line.is_debit', '=', 1)
        .executeTakeFirstOrThrow();
      expect(debitAccount.code).toBe('SUPPLIER_PREPAYMENTS');
    });
  });

  // ── Draw-down: customer prepayment → AR ────────────────────────────

  describe('drawDownPrepayment (customer)', () => {
    it('creates Dr CUSTOMER_PREPAYMENTS / Cr AR clearing voucher', async () => {
      // Create a customer prepayment of 50000.
      const txn = await seedBankTransaction(50000);
      const prepayVoucher = await prepaymentService.createCustomerPrepayment(
        txn.id,
      );

      // Create an AR invoice of 80000.
      const invoiceVoucherId = await seedSalesInvoiceVoucher(
        80000,
        '2025-01-20',
      );

      // Draw down 30000.
      const drawDown = await prepaymentService.drawDownPrepayment(
        prepayVoucher.id,
        invoiceVoucherId,
        30000,
      );

      expect(drawDown.id).toBeGreaterThan(0);
      expect(drawDown.lines).toHaveLength(2);

      const debitLine = drawDown.lines.find((l) => l.is_debit);
      const creditLine = drawDown.lines.find((l) => !l.is_debit);

      const debitAccount = await db
        .selectFrom('account')
        .select('code')
        .where('id', '=', debitLine!.account_id)
        .executeTakeFirstOrThrow();
      expect(debitAccount.code).toBe('CUSTOMER_PREPAYMENTS');

      const creditAccount = await db
        .selectFrom('account')
        .select('code')
        .where('id', '=', creditLine!.account_id)
        .executeTakeFirstOrThrow();
      expect(creditAccount.code).toBe('AR');

      expect(debitLine!.base_amount).toBe(30000);
      expect(creditLine!.base_amount).toBe(30000);
    });

    it('books cross-currency relief in base currency and leaves residual AR open', async () => {
      // Prepayment line carries USD (non-base) currency; base balance = 9000 EUR.
      const prepayVoucherId = await seedForeignCustomerPrepaymentVoucher(
        9000,
        'USD',
        '2025-01-15',
      );

      // USD AR invoice: gross 20000 USD booked at 0.85 → AR base = 17000 EUR.
      const { voucherId: invoiceVoucherId, arBase } =
        await seedForeignSalesInvoiceVoucher(20000, 'USD', 0.85, '2025-01-20');
      expect(arBase).toBe(17000);

      // Draw down the full prepayment (9000 base). drawAmount = min(req, 9000, 17000) = 9000.
      const drawDown = await prepaymentService.drawDownPrepayment(
        prepayVoucherId,
        invoiceVoucherId,
        20000,
      );

      const debitLine = drawDown.lines.find((l) => l.is_debit)!;
      const creditLine = drawDown.lines.find((l) => !l.is_debit)!;

      const debitAccount = await db
        .selectFrom('account')
        .select('code')
        .where('id', '=', debitLine.account_id)
        .executeTakeFirstOrThrow();
      expect(debitAccount.code).toBe('CUSTOMER_PREPAYMENTS');

      const creditAccount = await db
        .selectFrom('account')
        .select('code')
        .where('id', '=', creditLine.account_id)
        .executeTakeFirstOrThrow();
      expect(creditAccount.code).toBe('AR');

      // Both legs booked in BASE currency (EUR), not the prepayment's stored USD.
      expect(debitLine.currency).toBe('EUR');
      expect(creditLine.currency).toBe('EUR');
      expect(creditLine.base_amount).toBe(9000);
      expect(debitLine.base_amount).toBe(9000);
      expect(creditLine.amount).toBe(9000);
      expect(creditLine.fx_rate).toBe(1.0);
      expect(debitLine.fx_rate).toBe(1.0);

      // Voucher balances in base.
      expect(debitLine.base_amount).toBe(creditLine.base_amount);

      // Residual AR remains open: 17000 - 9000 = 8000 (rate difference surfaces
      // as open balance, settled later by cash — no realized-FX at draw-down).
      const invoiceBalance = await (
        prepaymentService as unknown as {
          getInvoiceBalance: (
            id: number,
          ) => Promise<{ accountCode: string; remaining: number } | null>;
        }
      ).getInvoiceBalance(invoiceVoucherId);
      expect(invoiceBalance!.remaining).toBe(8000);
    });

    it('clamps draw-down to prepayment remaining balance', async () => {
      const txn = await seedBankTransaction(20000);
      const prepayVoucher = await prepaymentService.createCustomerPrepayment(
        txn.id,
      );

      const invoiceVoucherId = await seedSalesInvoiceVoucher(
        50000,
        '2025-01-20',
      );

      // Request 30000 but only 20000 is available.
      const drawDown = await prepaymentService.drawDownPrepayment(
        prepayVoucher.id,
        invoiceVoucherId,
        30000,
      );

      expect(drawDown.lines[0].base_amount).toBe(20000);
    });

    it('clamps draw-down to invoice remaining balance', async () => {
      const txn = await seedBankTransaction(50000);
      const prepayVoucher = await prepaymentService.createCustomerPrepayment(
        txn.id,
      );

      const invoiceVoucherId = await seedSalesInvoiceVoucher(
        15000,
        '2025-01-20',
      );

      // Request 30000 but invoice is only 15000.
      const drawDown = await prepaymentService.drawDownPrepayment(
        prepayVoucher.id,
        invoiceVoucherId,
        30000,
      );

      expect(drawDown.lines[0].base_amount).toBe(15000);
    });

    it('rejects draw-down against a non-prepayment voucher', async () => {
      const invoiceVoucherId = await seedSalesInvoiceVoucher(
        50000,
        '2025-01-20',
      );

      await expect(
        prepaymentService.drawDownPrepayment(
          invoiceVoucherId,
          invoiceVoucherId,
          10000,
        ),
      ).rejects.toThrow('not found');
    });

    it('rejects customer prepayment drawn against AP invoice', async () => {
      const txn = await seedBankTransaction(50000);
      const prepayVoucher = await prepaymentService.createCustomerPrepayment(
        txn.id,
      );

      const apVoucherId = await seedExpenseVoucher(30000, '2025-01-20');

      await expect(
        prepaymentService.drawDownPrepayment(
          prepayVoucher.id,
          apVoucherId,
          10000,
        ),
      ).rejects.toThrow('AR');
    });

    it('rejects draw-down on exhausted prepayment', async () => {
      const txn = await seedBankTransaction(20000);
      const prepayVoucher = await prepaymentService.createCustomerPrepayment(
        txn.id,
      );

      const invoiceVoucherId = await seedSalesInvoiceVoucher(
        50000,
        '2025-01-20',
      );

      // First draw-down: exhaust the prepayment.
      await prepaymentService.drawDownPrepayment(
        prepayVoucher.id,
        invoiceVoucherId,
        20000,
      );

      // Second draw-down: should fail.
      await expect(
        prepaymentService.drawDownPrepayment(
          prepayVoucher.id,
          invoiceVoucherId,
          5000,
        ),
      ).rejects.toThrow('no remaining balance');
    });

    it('supports partial draw-downs (multiple draws)', async () => {
      const txn = await seedBankTransaction(60000);
      const prepayVoucher = await prepaymentService.createCustomerPrepayment(
        txn.id,
      );

      const invoiceVoucherId = await seedSalesInvoiceVoucher(
        100000,
        '2025-01-20',
      );

      // First draw: 20000.
      const draw1 = await prepaymentService.drawDownPrepayment(
        prepayVoucher.id,
        invoiceVoucherId,
        20000,
      );
      expect(draw1.lines[0].base_amount).toBe(20000);

      // Second draw: 15000.
      const draw2 = await prepaymentService.drawDownPrepayment(
        prepayVoucher.id,
        invoiceVoucherId,
        15000,
      );
      expect(draw2.lines[0].base_amount).toBe(15000);

      // Remaining should be 25000.
      const outstanding = await prepaymentService.listOutstandingPrepayments();
      const prepayRecord = outstanding.find(
        (p) => p.voucherId === prepayVoucher.id,
      );
      expect(prepayRecord).toBeDefined();
      expect(prepayRecord!.remaining).toBe(25000);
      expect(prepayRecord!.drawnDown).toBe(35000);
    });
  });

  // ── Draw-down: supplier prepayment → AP ────────────────────────────

  describe('drawDownPrepayment (supplier)', () => {
    it('creates Dr AP / Cr SUPPLIER_PREPAYMENTS clearing voucher', async () => {
      const txn = await seedBankTransaction(-30000);
      const prepayVoucher = await prepaymentService.createSupplierPrepayment(
        txn.id,
      );

      const invoiceVoucherId = await seedExpenseVoucher(50000, '2025-01-20');

      const drawDown = await prepaymentService.drawDownPrepayment(
        prepayVoucher.id,
        invoiceVoucherId,
        20000,
      );

      expect(drawDown.id).toBeGreaterThan(0);

      const debitLine = drawDown.lines.find((l) => l.is_debit);
      const creditLine = drawDown.lines.find((l) => !l.is_debit);

      const debitAccount = await db
        .selectFrom('account')
        .select('code')
        .where('id', '=', debitLine!.account_id)
        .executeTakeFirstOrThrow();
      expect(debitAccount.code).toBe('AP');

      const creditAccount = await db
        .selectFrom('account')
        .select('code')
        .where('id', '=', creditLine!.account_id)
        .executeTakeFirstOrThrow();
      expect(creditAccount.code).toBe('SUPPLIER_PREPAYMENTS');
    });

    it('rejects supplier prepayment drawn against AR invoice', async () => {
      const txn = await seedBankTransaction(-30000);
      const prepayVoucher = await prepaymentService.createSupplierPrepayment(
        txn.id,
      );

      const arVoucherId = await seedSalesInvoiceVoucher(50000, '2025-01-20');

      await expect(
        prepaymentService.drawDownPrepayment(
          prepayVoucher.id,
          arVoucherId,
          10000,
        ),
      ).rejects.toThrow('AP');
    });
  });

  // ── List outstanding prepayments ───────────────────────────────────

  describe('listOutstandingPrepayments', () => {
    it('returns outstanding customer prepayments', async () => {
      const txn = await seedBankTransaction(50000);
      await prepaymentService.createCustomerPrepayment(txn.id);

      const outstanding = await prepaymentService.listOutstandingPrepayments();

      expect(outstanding.length).toBeGreaterThanOrEqual(1);
      const prepay = outstanding.find(
        (p) => p.accountCode === 'CUSTOMER_PREPAYMENTS',
      );
      expect(prepay).toBeDefined();
      expect(prepay!.originalAmount).toBe(50000);
      expect(prepay!.remaining).toBe(50000);
      expect(prepay!.drawnDown).toBe(0);
    });

    it('returns outstanding supplier prepayments', async () => {
      const txn = await seedBankTransaction(-25000);
      await prepaymentService.createSupplierPrepayment(txn.id);

      const outstanding = await prepaymentService.listOutstandingPrepayments();

      const prepay = outstanding.find(
        (p) => p.accountCode === 'SUPPLIER_PREPAYMENTS',
      );
      expect(prepay).toBeDefined();
      expect(prepay!.originalAmount).toBe(25000);
      expect(prepay!.remaining).toBe(25000);
    });

    it('does NOT return fully drawn-down prepayments', async () => {
      const txn = await seedBankTransaction(30000);
      const prepayVoucher = await prepaymentService.createCustomerPrepayment(
        txn.id,
      );

      const invoiceVoucherId = await seedSalesInvoiceVoucher(
        50000,
        '2025-01-20',
      );

      // Draw down the full amount.
      await prepaymentService.drawDownPrepayment(
        prepayVoucher.id,
        invoiceVoucherId,
        30000,
      );

      const outstanding = await prepaymentService.listOutstandingPrepayments();

      const prepay = outstanding.find((p) => p.voucherId === prepayVoucher.id);
      expect(prepay).toBeUndefined();
    });

    it('shows reduced remaining after partial draw-down', async () => {
      const txn = await seedBankTransaction(40000);
      const prepayVoucher = await prepaymentService.createCustomerPrepayment(
        txn.id,
      );

      const invoiceVoucherId = await seedSalesInvoiceVoucher(
        50000,
        '2025-01-20',
      );

      await prepaymentService.drawDownPrepayment(
        prepayVoucher.id,
        invoiceVoucherId,
        15000,
      );

      const outstanding = await prepaymentService.listOutstandingPrepayments();

      const prepay = outstanding.find((p) => p.voucherId === prepayVoucher.id);
      expect(prepay).toBeDefined();
      expect(prepay!.originalAmount).toBe(40000);
      expect(prepay!.drawnDown).toBe(15000);
      expect(prepay!.remaining).toBe(25000);
    });
  });
});

/**
 * Cross-currency prepayment creation: the bank leg must resolve the REAL bank
 * account (e.g. BANK_USD) and carry the transaction's own currency, while the
 * foreign amount is converted to base currency (EUR) for the prepayment leg
 * via the country plugin's reference rate (D4).
 *
 * Uses a fake PluginLoader so USD→EUR = 0.9. (NullCountryPlugin throws on a
 * real cross-currency pair, so a fake is required.)
 */
describe('PrepaymentService — cross-currency bank account', () => {
  let db: Kysely<Database>;
  let prepaymentService: PrepaymentService;
  let bankStatementService: BankStatementService;

  /** Fake plugin: USD→EUR = 0.9; same-currency = 1.0. */
  const fakePlugin: Pick<
    CountryPlugin,
    'getReferenceRate' | 'getDefaultBaseCurrency'
  > = {
    getReferenceRate(from: string, to: string): number {
      if (from === to) return 1.0;
      if (from === 'USD' && to === 'EUR') return 0.9;
      throw new Error(`Unexpected pair ${from} → ${to}`);
    },
    getDefaultBaseCurrency: () => 'EUR',
  };

  const fakeLoader = {
    resolve: () => fakePlugin as unknown as CountryPlugin,
  };

  beforeEach(async () => {
    db = new Kysely<Database>({
      dialect: new SqliteDialect({ database: new SqliteDb(':memory:') }),
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
        AccountService,
        LedgerValidationService,
        PostingService,
        PeriodLockService,
        BankTransactionRepository,
        BankStatementService,
        OrganizationService,
        NullCountryPlugin,
        EstoniaCountryPlugin,
        PluginLoader,
        CurrencyService,
        PrepaymentService,
      ],
    })
      .overrideProvider(PluginLoader)
      .useValue(fakeLoader)
      .compile();

    prepaymentService = module.get(PrepaymentService);
    bankStatementService = module.get(BankStatementService);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('resolves BANK_USD and converts an incoming USD payment to base EUR (customer)', async () => {
    const stmt = await bankStatementService.createStatement({
      account_code: 'BANK_USD',
      start_date: '2025-01-01',
      end_date: '2025-01-31',
      transactions: [
        {
          transaction_date: '2025-01-15',
          description: 'Customer payment received - USD',
          amount: 10000,
          currency: 'USD',
          status: 'open',
        },
      ],
    });
    const txn = stmt.transactions[0];

    const voucher = await prepaymentService.createCustomerPrepayment(txn.id);

    const debitLine = voucher.lines.find((l) => l.is_debit)!;
    const creditLine = voucher.lines.find((l) => !l.is_debit)!;

    // Bank leg (debit): real BANK_USD account, USD currency, converted base.
    const debitAccount = await db
      .selectFrom('account')
      .select('code')
      .where('id', '=', debitLine.account_id)
      .executeTakeFirstOrThrow();
    expect(debitAccount.code).toBe('BANK_USD');
    expect(debitLine.currency).toBe('USD');
    expect(debitLine.amount).toBe(10000);
    expect(debitLine.base_amount).toBe(9000); // round(10000 * 0.9)
    expect(debitLine.fx_rate).toBe(0.9);
    expect(debitLine.is_debit).toBe(true);

    // Prepayment leg (credit): base currency EUR, base amount, rate 1.0.
    const creditAccount = await db
      .selectFrom('account')
      .select('code')
      .where('id', '=', creditLine.account_id)
      .executeTakeFirstOrThrow();
    expect(creditAccount.code).toBe('CUSTOMER_PREPAYMENTS');
    expect(creditLine.currency).toBe('EUR');
    expect(creditLine.amount).toBe(9000);
    expect(creditLine.base_amount).toBe(9000);
    expect(creditLine.fx_rate).toBe(1.0);
    expect(creditLine.is_debit).toBe(false);
  });

  it('resolves BANK_USD and converts an outgoing USD payment to base EUR (supplier)', async () => {
    const stmt = await bankStatementService.createStatement({
      account_code: 'BANK_USD',
      start_date: '2025-01-01',
      end_date: '2025-01-31',
      transactions: [
        {
          transaction_date: '2025-01-15',
          description: 'Supplier payment sent - USD',
          amount: -10000,
          currency: 'USD',
          status: 'open',
        },
      ],
    });
    const txn = stmt.transactions[0];

    const voucher = await prepaymentService.createSupplierPrepayment(txn.id);

    const debitLine = voucher.lines.find((l) => l.is_debit)!;
    const creditLine = voucher.lines.find((l) => !l.is_debit)!;

    // Prepayment leg (debit): base currency EUR, base amount, rate 1.0.
    const debitAccount = await db
      .selectFrom('account')
      .select('code')
      .where('id', '=', debitLine.account_id)
      .executeTakeFirstOrThrow();
    expect(debitAccount.code).toBe('SUPPLIER_PREPAYMENTS');
    expect(debitLine.currency).toBe('EUR');
    expect(debitLine.amount).toBe(9000);
    expect(debitLine.base_amount).toBe(9000);
    expect(debitLine.fx_rate).toBe(1.0);
    expect(debitLine.is_debit).toBe(true);

    // Bank leg (credit): real BANK_USD account, USD currency, converted base.
    const creditAccount = await db
      .selectFrom('account')
      .select('code')
      .where('id', '=', creditLine.account_id)
      .executeTakeFirstOrThrow();
    expect(creditAccount.code).toBe('BANK_USD');
    expect(creditLine.currency).toBe('USD');
    expect(creditLine.amount).toBe(10000);
    expect(creditLine.base_amount).toBe(9000); // round(10000 * 0.9)
    expect(creditLine.fx_rate).toBe(0.9);
    expect(creditLine.is_debit).toBe(false);
  });
});
