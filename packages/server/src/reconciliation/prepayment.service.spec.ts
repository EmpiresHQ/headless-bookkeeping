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
import { OrgContextResolver } from '../organization/org-context.resolver';
import { NullCountryPlugin } from '../plugins/null-country.plugin';
import { EstoniaCountryPlugin } from '../plugins/estonia-country.plugin';
import { PluginLoader } from '../plugins/plugin-loader.service';
import { CurrencyService } from '../currency/currency.service';
import { CountryPlugin } from '../plugins/country-plugin.interface';
import { EntitiesService } from '../entities/entities.service';
import { LedgerBalanceService } from '../ledger/account/ledger-balance.service';
import { OutstandingVoucherService } from './outstanding-voucher.service';
import { PrepaymentAllocationRepository } from './prepayment-allocation.repository';
import { PrepaymentService } from './prepayment.service';

/**
 * Integration test for prepayment creation and draw-down.
 * Uses real SQLite in-memory with full migrations (real-DI test, G2 gate).
 */
describe('PrepaymentService (integration)', () => {
  let db: Kysely<Database>;
  let prepaymentService: PrepaymentService;
  let bankStatementService: BankStatementService;
  let transactionRepo: BankTransactionRepository;
  let postingService: PostingService;
  let outstandingVoucherService: OutstandingVoucherService;
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
        OrgContextResolver,
        EntitiesService,
        LedgerBalanceService,
        OutstandingVoucherService,
        PrepaymentAllocationRepository,
        PrepaymentService,
      ],
    }).compile();

    prepaymentService = module.get(PrepaymentService);
    bankStatementService = module.get(BankStatementService);
    transactionRepo = module.get(BankTransactionRepository);
    postingService = module.get(PostingService);
    outstandingVoucherService = module.get(OutstandingVoucherService);
  });

  afterEach(async () => {
    await db.destroy();
  });

  // ── Helpers ──────────────────────────────────────────────────────────

  async function seedBankTransaction(
    amount: number,
    status = 'open',
    counterpartyIban?: string,
  ) {
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
          counterparty_iban: counterpartyIban ?? null,
          status: status as 'open' | 'prepayment',
        },
      ],
    });
    return stmt.transactions[0];
  }

  /** A counterparty to own an advance/invoice. */
  async function seedEntity(
    role: 'customer' | 'supplier',
    name: string,
  ): Promise<number> {
    const now = Math.floor(Date.now() / 1000);
    const row = await db
      .insertInto('entity')
      .values({
        role,
        country: 'IE',
        name,
        goods_vs_services: 'services',
        created_at: now,
        updated_at: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return row.id;
  }

  /**
   * Bind a posted AR voucher to a **Customer** via its SalesInvoice, so the
   * draw-down path can verify both sides name the same counterparty.
   */
  async function bindSalesInvoice(
    voucherId: number,
    customerId: number,
    grossCents: number,
  ): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    await db
      .insertInto('sales_invoice')
      .values({
        customer_id: customerId,
        invoice_number: `INV-${voucherId}`,
        gross_amount: grossCents,
        vat_amount: 0,
        currency: 'EUR',
        tax_point_date: '2025-01-20',
        due_date: null,
        status: 'posted',
        sent_at: null,
        voucher_id: voucherId,
        document_vat_marking: null,
        document_id: null,
        created_at: now,
        updated_at: now,
      })
      .execute();
  }

  /** Bind a posted AP voucher to a **Supplier** via its Expense. */
  async function bindExpense(
    voucherId: number,
    supplierId: number,
    grossCents: number,
  ): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    await db
      .insertInto('expense')
      .values({
        document_id: null,
        supplier_id: supplierId,
        category: 'software',
        gross_amount: grossCents,
        vat_amount: 0,
        currency: 'EUR',
        tax_point_date: '2025-01-20',
        status: 'posted',
        voucher_id: voucherId,
        created_at: now,
        updated_at: now,
      })
      .execute();
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

  /**
   * Post a mirrored counter-voucher for `voucherId` through the real posting
   * path — the ledger's own way of undoing a posted Voucher (ADR-0009).
   */
  async function reverseVoucher(voucherId: number): Promise<number> {
    const lines = await db
      .selectFrom('voucher_line')
      .innerJoin('account', 'account.id', 'voucher_line.account_id')
      .select([
        'account.code as code',
        'voucher_line.amount as amount',
        'voucher_line.currency as currency',
        'voucher_line.base_amount as base_amount',
        'voucher_line.fx_rate as fx_rate',
        'voucher_line.is_debit as is_debit',
      ])
      .where('voucher_line.voucher_id', '=', voucherId)
      .execute();

    const reversal = await postingService.postVoucher({
      tax_point_date: new Date().toISOString().slice(0, 10),
      reverses_id: voucherId,
      reason: 'test reversal',
      lines: lines.map((l) => ({
        account_code: l.code,
        amount: l.amount,
        currency: l.currency,
        base_amount: l.base_amount,
        fx_rate: l.fx_rate,
        is_debit: l.is_debit !== 1,
      })),
    });
    return reversal.id;
  }

  /**
   * A posted Dr CUSTOMER_PREPAYMENTS / Cr AR clearing voucher with NO
   * allocation record — the shape a pre-#201 draw-down left behind.
   */
  async function seedClearingVoucher(
    invoiceVoucherId: number,
    amount: number,
  ): Promise<number> {
    const voucher = await postingService.postVoucher({
      tax_point_date: '2025-01-25',
      reason: `Draw-down of prepayment V-0 against invoice V-${invoiceVoucherId}`,
      lines: [
        {
          account_code: 'CUSTOMER_PREPAYMENTS',
          amount,
          currency: 'EUR',
          base_amount: amount,
          fx_rate: 1.0,
          is_debit: true,
        },
        {
          account_code: 'AR',
          amount,
          currency: 'EUR',
          base_amount: amount,
          fx_rate: 1.0,
          is_debit: false,
        },
      ],
    });
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

    it('rolls back the voucher if the bank transaction status update fails', async () => {
      const txn = await seedBankTransaction(30000);
      const before = await db
        .selectFrom('voucher')
        .select(({ fn }) => fn.count<number>('id').as('count'))
        .executeTakeFirstOrThrow();

      jest
        .spyOn(transactionRepo, 'updateStatus')
        .mockRejectedValueOnce(new Error('forced status failure'));

      await expect(
        prepaymentService.createCustomerPrepayment(txn.id),
      ).rejects.toThrow('forced status failure');

      const after = await db
        .selectFrom('voucher')
        .select(({ fn }) => fn.count<number>('id').as('count'))
        .executeTakeFirstOrThrow();
      const updated = await db
        .selectFrom('bank_transaction')
        .select('status')
        .where('id', '=', txn.id)
        .executeTakeFirstOrThrow();

      expect(after.count).toBe(before.count);
      expect(updated.status).toBe('open');
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
      const customerId = await seedEntity('customer', 'Cust A');
      // Create a customer prepayment of 50000.
      const txn = await seedBankTransaction(50000);
      const prepayVoucher = await prepaymentService.createCustomerPrepayment(
        txn.id,
        customerId,
      );

      // Create an AR invoice of 80000.
      const invoiceVoucherId = await seedSalesInvoiceVoucher(
        80000,
        '2025-01-20',
      );
      await bindSalesInvoice(invoiceVoucherId, customerId, 80000);

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

      // The allocation itself is persisted: source advance, target invoice,
      // counterparty, amount, and the voucher that evidences it (issue #201).
      const allocation = await db
        .selectFrom('prepayment_allocation')
        .innerJoin(
          'prepayment_advance',
          'prepayment_advance.id',
          'prepayment_allocation.advance_id',
        )
        .selectAll('prepayment_allocation')
        .select('prepayment_advance.voucher_id as advance_voucher_id')
        .executeTakeFirstOrThrow();
      expect(allocation.advance_voucher_id).toBe(prepayVoucher.id);
      expect(allocation.invoice_voucher_id).toBe(invoiceVoucherId);
      expect(allocation.entity_id).toBe(customerId);
      expect(allocation.base_amount).toBe(30000);
      expect(allocation.allocation_voucher_id).toBe(drawDown.id);
    });

    it('books cross-currency relief in base currency and leaves residual AR open', async () => {
      const customerId = await seedEntity('customer', 'Cust FX');
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
      await bindSalesInvoice(invoiceVoucherId, customerId, 20000);

      // A prepayment voucher posted outside this service carries no advance
      // record, so it is registered through the documented repair path before
      // it can be drawn down (issue #201).
      await prepaymentService.resolveAdvanceOwnership(prepayVoucherId, {
        entityId: customerId,
      });

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
      const customerId = await seedEntity('customer', 'Cust A');
      const txn = await seedBankTransaction(20000);
      const prepayVoucher = await prepaymentService.createCustomerPrepayment(
        txn.id,
        customerId,
      );

      const invoiceVoucherId = await seedSalesInvoiceVoucher(
        50000,
        '2025-01-20',
      );
      await bindSalesInvoice(invoiceVoucherId, customerId, 50000);

      // Request 30000 but only 20000 is available.
      const drawDown = await prepaymentService.drawDownPrepayment(
        prepayVoucher.id,
        invoiceVoucherId,
        30000,
      );

      expect(drawDown.lines[0].base_amount).toBe(20000);
    });

    it('clamps draw-down to invoice remaining balance', async () => {
      const customerId = await seedEntity('customer', 'Cust A');
      const txn = await seedBankTransaction(50000);
      const prepayVoucher = await prepaymentService.createCustomerPrepayment(
        txn.id,
        customerId,
      );

      const invoiceVoucherId = await seedSalesInvoiceVoucher(
        15000,
        '2025-01-20',
      );
      await bindSalesInvoice(invoiceVoucherId, customerId, 15000);

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

    it('rejects a non-integer or non-positive amount', async () => {
      const customerId = await seedEntity('customer', 'Cust A');
      const txn = await seedBankTransaction(50000);
      const prepayVoucher = await prepaymentService.createCustomerPrepayment(
        txn.id,
        customerId,
      );
      const invoiceVoucherId = await seedSalesInvoiceVoucher(
        50000,
        '2025-01-20',
      );
      await bindSalesInvoice(invoiceVoucherId, customerId, 50000);

      await expect(
        prepaymentService.drawDownPrepayment(
          prepayVoucher.id,
          invoiceVoucherId,
          1000.5,
        ),
      ).rejects.toThrow('whole number');
      await expect(
        prepaymentService.drawDownPrepayment(
          prepayVoucher.id,
          invoiceVoucherId,
          0,
        ),
      ).rejects.toThrow('positive');
    });

    it('rejects customer prepayment drawn against AP invoice', async () => {
      const customerId = await seedEntity('customer', 'Cust A');
      const txn = await seedBankTransaction(50000);
      const prepayVoucher = await prepaymentService.createCustomerPrepayment(
        txn.id,
        customerId,
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
      const customerId = await seedEntity('customer', 'Cust A');
      const txn = await seedBankTransaction(20000);
      const prepayVoucher = await prepaymentService.createCustomerPrepayment(
        txn.id,
        customerId,
      );

      const invoiceVoucherId = await seedSalesInvoiceVoucher(
        50000,
        '2025-01-20',
      );
      await bindSalesInvoice(invoiceVoucherId, customerId, 50000);

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
      const customerId = await seedEntity('customer', 'Cust A');
      const txn = await seedBankTransaction(60000);
      const prepayVoucher = await prepaymentService.createCustomerPrepayment(
        txn.id,
        customerId,
      );

      const invoiceVoucherId = await seedSalesInvoiceVoucher(
        100000,
        '2025-01-20',
      );
      await bindSalesInvoice(invoiceVoucherId, customerId, 100000);

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
      const supplierId = await seedEntity('supplier', 'Supp A');
      const txn = await seedBankTransaction(-30000);
      const prepayVoucher = await prepaymentService.createSupplierPrepayment(
        txn.id,
        supplierId,
      );

      const invoiceVoucherId = await seedExpenseVoucher(50000, '2025-01-20');
      await bindExpense(invoiceVoucherId, supplierId, 50000);

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
      const supplierId = await seedEntity('supplier', 'Supp A');
      const txn = await seedBankTransaction(-30000);
      const prepayVoucher = await prepaymentService.createSupplierPrepayment(
        txn.id,
        supplierId,
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

  // ── Issue #201: advance isolation, ownership and allocation ────────

  describe('advance isolation (#201)', () => {
    it('leaves an unrelated advance untouched when another is drawn down', async () => {
      const customerId = await seedEntity('customer', 'Cust A');
      const txnA = await seedBankTransaction(10000);
      const advanceA = await prepaymentService.createCustomerPrepayment(
        txnA.id,
        customerId,
      );
      const txnB = await seedBankTransaction(10000);
      const advanceB = await prepaymentService.createCustomerPrepayment(
        txnB.id,
        customerId,
      );

      const invoiceVoucherId = await seedSalesInvoiceVoucher(
        10000,
        '2025-01-20',
      );
      await bindSalesInvoice(invoiceVoucherId, customerId, 10000);

      await prepaymentService.drawDownPrepayment(
        advanceA.id,
        invoiceVoucherId,
        1000,
      );

      const outstanding = await prepaymentService.listOutstandingPrepayments();
      const a = outstanding.find((p) => p.voucherId === advanceA.id)!;
      const b = outstanding.find((p) => p.voucherId === advanceB.id)!;

      expect(a.drawnDown).toBe(1000);
      expect(a.remaining).toBe(9000);
      // B has never been used: before #201 it reported 9000 too.
      expect(b.drawnDown).toBe(0);
      expect(b.remaining).toBe(10000);

      // The draw-down voucher's own prepayment leg is not an advance.
      expect(
        outstanding.some(
          (p) => p.voucherId !== advanceA.id && p.voucherId !== advanceB.id,
        ),
      ).toBe(false);
    });

    it('keeps supplier advances independent of each other', async () => {
      const supplierId = await seedEntity('supplier', 'Supp A');
      const txnA = await seedBankTransaction(-10000);
      const advanceA = await prepaymentService.createSupplierPrepayment(
        txnA.id,
        supplierId,
      );
      const txnB = await seedBankTransaction(-10000);
      const advanceB = await prepaymentService.createSupplierPrepayment(
        txnB.id,
        supplierId,
      );

      const billVoucherId = await seedExpenseVoucher(10000, '2025-01-20');
      await bindExpense(billVoucherId, supplierId, 10000);

      await prepaymentService.drawDownPrepayment(
        advanceA.id,
        billVoucherId,
        2500,
      );

      const outstanding = await prepaymentService.listOutstandingPrepayments();
      expect(
        outstanding.find((p) => p.voucherId === advanceA.id)!.remaining,
      ).toBe(7500);
      expect(
        outstanding.find((p) => p.voucherId === advanceB.id)!.remaining,
      ).toBe(10000);
    });

    it('refuses a cross-counterparty allocation', async () => {
      const owner = await seedEntity('customer', 'Cust A');
      const other = await seedEntity('customer', 'Cust B');
      const txn = await seedBankTransaction(10000);
      const advance = await prepaymentService.createCustomerPrepayment(
        txn.id,
        owner,
      );

      const invoiceVoucherId = await seedSalesInvoiceVoucher(
        10000,
        '2025-01-20',
      );
      await bindSalesInvoice(invoiceVoucherId, other, 10000);

      await expect(
        prepaymentService.drawDownPrepayment(
          advance.id,
          invoiceVoucherId,
          1000,
        ),
      ).rejects.toThrow('Cross-counterparty');
    });

    it('refuses an invoice whose counterparty cannot be resolved', async () => {
      const owner = await seedEntity('customer', 'Cust A');
      const txn = await seedBankTransaction(10000);
      const advance = await prepaymentService.createCustomerPrepayment(
        txn.id,
        owner,
      );

      // A raw AR voucher with no SalesInvoice behind it names nobody.
      const invoiceVoucherId = await seedSalesInvoiceVoucher(
        10000,
        '2025-01-20',
      );

      await expect(
        prepaymentService.drawDownPrepayment(
          advance.id,
          invoiceVoucherId,
          1000,
        ),
      ).rejects.toThrow('no resolved counterparty');
    });

    it('refuses a customer advance owned by a supplier entity', async () => {
      const supplierId = await seedEntity('supplier', 'Supp A');
      const txn = await seedBankTransaction(10000);

      await expect(
        prepaymentService.createCustomerPrepayment(txn.id, supplierId),
      ).rejects.toThrow("role 'supplier'");
    });

    it('resolves the owner from the bank line, and blocks the advance when it cannot', async () => {
      const customerId = await seedEntity('customer', 'Cust IBAN');
      await db
        .insertInto('entity_identifier')
        .values({
          entity_id: customerId,
          kind: 'iban',
          value: 'IE29AIBK93115212345678',
          confirmed: 1,
        })
        .execute();

      const known = await seedBankTransaction(
        10000,
        'open',
        'IE29AIBK93115212345678',
      );
      const resolved = await prepaymentService.createCustomerPrepayment(
        known.id,
      );

      const unknown = await seedBankTransaction(10000);
      const unresolved = await prepaymentService.createCustomerPrepayment(
        unknown.id,
      );

      const outstanding = await prepaymentService.listOutstandingPrepayments();
      const ok = outstanding.find((p) => p.voucherId === resolved.id)!;
      expect(ok.entityId).toBe(customerId);
      expect(ok.allocatable).toBe(true);

      const blocked = outstanding.find((p) => p.voucherId === unresolved.id)!;
      expect(blocked.entityId).toBeNull();
      expect(blocked.allocatable).toBe(false);
      expect(blocked.unresolvedReason).toBe('unknown_counterparty');

      const invoiceVoucherId = await seedSalesInvoiceVoucher(
        10000,
        '2025-01-20',
      );
      await bindSalesInvoice(invoiceVoucherId, customerId, 10000);
      await expect(
        prepaymentService.drawDownPrepayment(
          unresolved.id,
          invoiceVoucherId,
          1000,
        ),
      ).rejects.toThrow('no resolved counterparty');
    });

    it('lets exactly one of two concurrent draw-downs win, and rolls the other back', async () => {
      const customerId = await seedEntity('customer', 'Cust A');
      const txn = await seedBankTransaction(10000);
      const advance = await prepaymentService.createCustomerPrepayment(
        txn.id,
        customerId,
      );

      const invoiceA = await seedSalesInvoiceVoucher(10000, '2025-01-20');
      await bindSalesInvoice(invoiceA, customerId, 10000);
      const invoiceB = await seedSalesInvoiceVoucher(10000, '2025-01-21');
      await bindSalesInvoice(invoiceB, customerId, 10000);

      // Both ask for the WHOLE advance against different invoices, so neither
      // is clamped by the other's target.
      const results = await Promise.allSettled([
        prepaymentService.drawDownPrepayment(advance.id, invoiceA, 10000),
        prepaymentService.drawDownPrepayment(advance.id, invoiceB, 10000),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      expect(fulfilled).toHaveLength(1);

      // The loser wrote nothing: one allocation, and the advance is exactly
      // exhausted rather than overdrawn.
      const allocations = await db
        .selectFrom('prepayment_allocation')
        .selectAll()
        .execute();
      expect(allocations).toHaveLength(1);

      const outstanding = await prepaymentService.listOutstandingPrepayments();
      expect(
        outstanding.find((p) => p.voucherId === advance.id),
      ).toBeUndefined();
    });

    it('releases only the reversed allocation, on either side', async () => {
      const customerId = await seedEntity('customer', 'Cust A');
      const txn = await seedBankTransaction(10000);
      const advance = await prepaymentService.createCustomerPrepayment(
        txn.id,
        customerId,
      );

      const invoiceVoucherId = await seedSalesInvoiceVoucher(
        10000,
        '2025-01-20',
      );
      await bindSalesInvoice(invoiceVoucherId, customerId, 10000);

      const first = await prepaymentService.drawDownPrepayment(
        advance.id,
        invoiceVoucherId,
        3000,
      );
      const second = await prepaymentService.drawDownPrepayment(
        advance.id,
        invoiceVoucherId,
        2000,
      );

      await reverseVoucher(first.id);

      const outstanding = await prepaymentService.listOutstandingPrepayments();
      const record = outstanding.find((p) => p.voucherId === advance.id)!;
      // Only the reversed 3000 came back; the untouched 2000 is still spent.
      expect(record.drawnDown).toBe(2000);
      expect(record.remaining).toBe(8000);

      // The invoice regained exactly the reversed relief too.
      const invoiceBalance = await (
        prepaymentService as unknown as {
          getInvoiceBalance: (
            id: number,
          ) => Promise<{ accountCode: string; remaining: number } | null>;
        }
      ).getInvoiceBalance(invoiceVoucherId);
      expect(invoiceBalance!.remaining).toBe(8000);

      // And the released credit can be drawn again.
      await expect(
        prepaymentService.drawDownPrepayment(
          advance.id,
          invoiceVoucherId,
          8000,
        ),
      ).resolves.toBeDefined();
      expect(second.id).toBeGreaterThan(0);
    });

    it('refuses to draw down an advance whose own voucher was reversed', async () => {
      const customerId = await seedEntity('customer', 'Cust A');
      const txn = await seedBankTransaction(10000);
      const advance = await prepaymentService.createCustomerPrepayment(
        txn.id,
        customerId,
      );
      const invoiceVoucherId = await seedSalesInvoiceVoucher(
        10000,
        '2025-01-20',
      );
      await bindSalesInvoice(invoiceVoucherId, customerId, 10000);

      await reverseVoucher(advance.id);

      await expect(
        prepaymentService.drawDownPrepayment(
          advance.id,
          invoiceVoucherId,
          1000,
        ),
      ).rejects.toThrow('reversed');

      const outstanding = await prepaymentService.listOutstandingPrepayments();
      const record = outstanding.find((p) => p.voucherId === advance.id)!;
      expect(record.allocatable).toBe(false);
      expect(record.unresolvedReason).toBe('advance_reversed');
    });

    it('does not let a cash settlement re-settle what an allocation relieved', async () => {
      const customerId = await seedEntity('customer', 'Cust A');
      const txn = await seedBankTransaction(4000);
      const advance = await prepaymentService.createCustomerPrepayment(
        txn.id,
        customerId,
      );

      const invoiceVoucherId = await seedSalesInvoiceVoucher(
        10000,
        '2025-01-20',
      );
      await bindSalesInvoice(invoiceVoucherId, customerId, 10000);

      await prepaymentService.drawDownPrepayment(
        advance.id,
        invoiceVoucherId,
        4000,
      );

      // 10000 invoice − 4000 allocated = 6000 left for cash, through the SAME
      // canonical outstanding the reconciliation engine reads.
      await expect(
        outstandingVoucherService.getRemainingVoucherBalance(invoiceVoucherId),
      ).resolves.toBe(6000);

      // Settle that 6000 in cash, then a further draw-down has nothing to take.
      await db
        .insertInto('reconciliation_match')
        .values({
          bank_transaction_id: txn.id,
          voucher_id: invoiceVoucherId,
          match_type: 'exact',
          amount_matched: 6000,
          status: 'active',
          signal: 'manual',
          fx_voucher_id: null,
          created_at: Math.floor(Date.now() / 1000),
        })
        .execute();

      await expect(
        outstandingVoucherService.getRemainingVoucherBalance(invoiceVoucherId),
      ).resolves.toBe(0);

      const second = await seedBankTransaction(4000);
      const advance2 = await prepaymentService.createCustomerPrepayment(
        second.id,
        customerId,
      );
      await expect(
        prepaymentService.drawDownPrepayment(
          advance2.id,
          invoiceVoucherId,
          1000,
        ),
      ).rejects.toThrow('no remaining balance');
    });
  });

  // ── Issue #201: operator repair of unresolved advances ─────────────

  describe('resolveAdvanceOwnership (#201)', () => {
    it('registers an unregistered prepayment voucher and blocks it until resolved', async () => {
      const customerId = await seedEntity('customer', 'Cust A');
      const prepayVoucherId = await seedForeignCustomerPrepaymentVoucher(
        10000,
        'EUR',
        '2025-01-15',
      );

      const before = await prepaymentService.listOutstandingPrepayments();
      const unregistered = before.find((p) => p.voucherId === prepayVoucherId)!;
      expect(unregistered.unresolvedReason).toBe('no_advance_record');
      expect(unregistered.remaining).toBeNull();
      expect(unregistered.allocatable).toBe(false);

      const resolved = await prepaymentService.resolveAdvanceOwnership(
        prepayVoucherId,
        { entityId: customerId },
      );
      expect(resolved.entityId).toBe(customerId);
      expect(resolved.remaining).toBe(10000);
      expect(resolved.allocatable).toBe(true);
    });

    it('treats a multi-leg advance voucher as ONE advance for its full amount', async () => {
      const customerId = await seedEntity('customer', 'Cust A');
      // One legal advance voucher whose prepayment credit arrives in two legs.
      const posted = await postingService.postVoucher({
        tax_point_date: '2025-01-15',
        lines: [
          {
            account_code: 'BANK_EUR',
            amount: 10000,
            currency: 'EUR',
            base_amount: 10000,
            fx_rate: 1.0,
            is_debit: true,
          },
          {
            account_code: 'CUSTOMER_PREPAYMENTS',
            amount: 6000,
            currency: 'EUR',
            base_amount: 6000,
            fx_rate: 1.0,
            is_debit: false,
          },
          {
            account_code: 'CUSTOMER_PREPAYMENTS',
            amount: 4000,
            currency: 'EUR',
            base_amount: 4000,
            fx_rate: 1.0,
            is_debit: false,
          },
        ],
      });

      const listed = (
        await prepaymentService.listOutstandingPrepayments()
      ).filter((p) => p.voucherId === posted.id);
      expect(listed).toHaveLength(1);
      expect(listed[0].originalAmount).toBe(10000);

      const resolved = await prepaymentService.resolveAdvanceOwnership(
        posted.id,
        { entityId: customerId },
      );
      expect(resolved.originalAmount).toBe(10000);
      expect(resolved.remaining).toBe(10000);
    });

    it('refuses to re-point a resolved advance at a different counterparty', async () => {
      const owner = await seedEntity('customer', 'Cust A');
      const other = await seedEntity('customer', 'Cust B');
      const txn = await seedBankTransaction(10000);
      const advance = await prepaymentService.createCustomerPrepayment(
        txn.id,
        owner,
      );

      await expect(
        prepaymentService.resolveAdvanceOwnership(advance.id, {
          entityId: other,
        }),
      ).rejects.toThrow('already belongs to entity');
    });

    it('lets the same owner come back and finish a flagged repair', async () => {
      const customerId = await seedEntity('customer', 'Cust A');
      const prepayVoucherId = await seedForeignCustomerPrepaymentVoucher(
        10000,
        'EUR',
        '2025-01-15',
      );
      const invoiceVoucherId = await seedSalesInvoiceVoucher(
        10000,
        '2025-01-20',
      );
      await bindSalesInvoice(invoiceVoucherId, customerId, 10000);
      // An unlinked historical draw-down: the advance's balance is unknown.
      const clearingId = await seedClearingVoucher(invoiceVoucherId, 4000);

      // First call: owner assigned, but the flag stays up because the
      // draw-down is still unattributed — and the advance stays blocked.
      const firstPass = await prepaymentService.resolveAdvanceOwnership(
        prepayVoucherId,
        { entityId: customerId },
      );
      expect(firstPass.entityId).toBe(customerId);
      expect(firstPass.unresolvedReason).toBe('balance_unverified');
      expect(firstPass.allocatable).toBe(false);
      await expect(
        prepaymentService.drawDownPrepayment(
          prepayVoucherId,
          invoiceVoucherId,
          1000,
        ),
      ).rejects.toThrow('unverified remaining balance');

      // Second call by the SAME owner finishes the repair with the evidence.
      const finished = await prepaymentService.resolveAdvanceOwnership(
        prepayVoucherId,
        {
          entityId: customerId,
          drawDowns: [{ allocationVoucherId: clearingId, invoiceVoucherId }],
        },
      );
      expect(finished.entityId).toBe(customerId);
      expect(finished.unresolvedReason).toBeNull();
      expect(finished.drawnDown).toBe(4000);
      expect(finished.remaining).toBe(6000);
      await expect(
        outstandingVoucherService.getRemainingVoucherBalance(invoiceVoucherId),
      ).resolves.toBe(6000);
    });

    it('refuses a link that overdraws an advance its active allocations already spent', async () => {
      const customerId = await seedEntity('customer', 'Cust A');
      const txn = await seedBankTransaction(10000);
      const advance = await prepaymentService.createCustomerPrepayment(
        txn.id,
        customerId,
      );
      const invoiceA = await seedSalesInvoiceVoucher(10000, '2025-01-20');
      await bindSalesInvoice(invoiceA, customerId, 10000);

      // 7000 of the 10000 advance is already allocated and live.
      const live = await prepaymentService.drawDownPrepayment(
        advance.id,
        invoiceA,
        7000,
      );

      // A historical 6000 draw-down cannot also have come from it.
      const invoiceB = await seedSalesInvoiceVoucher(10000, '2025-01-21');
      await bindSalesInvoice(invoiceB, customerId, 10000);
      const clearingId = await seedClearingVoucher(invoiceB, 6000);

      await expect(
        prepaymentService.resolveAdvanceOwnership(advance.id, {
          entityId: customerId,
          drawDowns: [
            { allocationVoucherId: clearingId, invoiceVoucherId: invoiceB },
          ],
        }),
      ).rejects.toThrow('exceed the remaining balance');

      // The live allocation and the owner are untouched.
      const rows = await db
        .selectFrom('prepayment_allocation')
        .selectAll()
        .execute();
      expect(rows).toHaveLength(1);
      expect(rows[0].allocation_voucher_id).toBe(live.id);
      const outstanding = await prepaymentService.listOutstandingPrepayments();
      const record = outstanding.find((p) => p.voucherId === advance.id)!;
      expect(record.entityId).toBe(customerId);
      expect(record.remaining).toBe(3000);
    });

    it('refuses an owner that a BACKFILLED allocation already contradicts', async () => {
      const owner = await seedEntity('customer', 'Cust A');
      const other = await seedEntity('customer', 'Cust B');
      const prepayVoucherId = await seedForeignCustomerPrepaymentVoucher(
        10000,
        'EUR',
        '2025-01-15',
      );
      const invoiceVoucherId = await seedSalesInvoiceVoucher(
        10000,
        '2025-01-20',
      );
      // The already-recorded history relieved an invoice of ANOTHER customer.
      await bindSalesInvoice(invoiceVoucherId, other, 10000);
      const clearingId = await seedClearingVoucher(invoiceVoucherId, 4000);

      const advanceId = await db
        .insertInto('prepayment_advance')
        .values({
          voucher_id: prepayVoucherId,
          kind: 'customer',
          account_code: 'CUSTOMER_PREPAYMENTS',
          entity_id: null,
          bank_transaction_id: null,
          original_base_amount: 10000,
          currency: 'EUR',
          needs_review: 0,
          origin: 'backfill',
          created_at: Math.floor(Date.now() / 1000),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      // A backfilled allocation carries no counterparty of its own.
      await db
        .insertInto('prepayment_allocation')
        .values({
          advance_id: advanceId.id,
          invoice_voucher_id: invoiceVoucherId,
          entity_id: null,
          base_amount: 4000,
          currency: 'EUR',
          allocation_voucher_id: clearingId,
          origin: 'backfill',
          created_at: Math.floor(Date.now() / 1000),
        })
        .execute();

      // Naming an owner is also a claim about that history, and it does not hold.
      await expect(
        prepaymentService.resolveAdvanceOwnership(prepayVoucherId, {
          entityId: owner,
        }),
      ).rejects.toThrow(`belongs to entity ${other}`);

      const advance = await db
        .selectFrom('prepayment_advance')
        .select('entity_id')
        .where('id', '=', advanceId.id)
        .executeTakeFirstOrThrow();
      expect(advance.entity_id).toBeNull();
    });

    it('links a historical draw-down by evidence and lifts the unverified flag', async () => {
      const customerId = await seedEntity('customer', 'Cust A');
      const prepayVoucherId = await seedForeignCustomerPrepaymentVoucher(
        10000,
        'EUR',
        '2025-01-15',
      );
      const invoiceVoucherId = await seedSalesInvoiceVoucher(
        10000,
        '2025-01-20',
      );
      await bindSalesInvoice(invoiceVoucherId, customerId, 10000);
      const clearingId = await seedClearingVoucher(invoiceVoucherId, 4000);

      // The unlinked clearing voucher makes the balance unverifiable.
      const registered = await db
        .insertInto('prepayment_advance')
        .values({
          voucher_id: prepayVoucherId,
          kind: 'customer',
          account_code: 'CUSTOMER_PREPAYMENTS',
          entity_id: null,
          bank_transaction_id: null,
          original_base_amount: 10000,
          currency: 'EUR',
          needs_review: 1,
          origin: 'backfill',
          created_at: Math.floor(Date.now() / 1000),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      expect(registered.id).toBeGreaterThan(0);

      const unverified = (
        await prepaymentService.listOutstandingPrepayments()
      ).find((p) => p.voucherId === prepayVoucherId)!;
      expect(unverified.unresolvedReason).toBe('balance_unverified');
      expect(unverified.remaining).toBeNull();

      const resolved = await prepaymentService.resolveAdvanceOwnership(
        prepayVoucherId,
        {
          entityId: customerId,
          drawDowns: [
            {
              allocationVoucherId: clearingId,
              invoiceVoucherId,
            },
          ],
        },
      );

      expect(resolved.remaining).toBe(6000);
      expect(resolved.drawnDown).toBe(4000);
      // The invoice is relieved by exactly the linked amount.
      await expect(
        outstandingVoucherService.getRemainingVoucherBalance(invoiceVoucherId),
      ).resolves.toBe(6000);
    });

    it('refuses a link that would over-relieve its target invoice', async () => {
      const customerId = await seedEntity('customer', 'Cust A');
      const prepayVoucherId = await seedForeignCustomerPrepaymentVoucher(
        10000,
        'EUR',
        '2025-01-15',
      );
      const invoiceVoucherId = await seedSalesInvoiceVoucher(
        3000,
        '2025-01-20',
      );
      await bindSalesInvoice(invoiceVoucherId, customerId, 3000);
      // A 4000 clearing voucher cannot belong to a 3000 invoice.
      const clearingId = await seedClearingVoucher(invoiceVoucherId, 4000);

      await expect(
        prepaymentService.resolveAdvanceOwnership(prepayVoucherId, {
          entityId: customerId,
          drawDowns: [{ allocationVoucherId: clearingId, invoiceVoucherId }],
        }),
      ).rejects.toThrow('exceeds the remaining balance of invoice');
    });

    it('refuses links that exceed the advance, writing nothing', async () => {
      const customerId = await seedEntity('customer', 'Cust A');
      const prepayVoucherId = await seedForeignCustomerPrepaymentVoucher(
        5000,
        'EUR',
        '2025-01-15',
      );
      const invoiceA = await seedSalesInvoiceVoucher(10000, '2025-01-20');
      await bindSalesInvoice(invoiceA, customerId, 10000);
      const invoiceB = await seedSalesInvoiceVoucher(10000, '2025-01-21');
      await bindSalesInvoice(invoiceB, customerId, 10000);
      const clearingA = await seedClearingVoucher(invoiceA, 4000);
      const clearingB = await seedClearingVoucher(invoiceB, 4000);

      await expect(
        prepaymentService.resolveAdvanceOwnership(prepayVoucherId, {
          entityId: customerId,
          drawDowns: [
            { allocationVoucherId: clearingA, invoiceVoucherId: invoiceA },
            { allocationVoucherId: clearingB, invoiceVoucherId: invoiceB },
          ],
        }),
      ).rejects.toThrow('exceed the remaining balance');

      // Atomic: neither link, nor the owner, was written.
      await expect(
        db.selectFrom('prepayment_allocation').selectAll().execute(),
      ).resolves.toEqual([]);
      const advance = await db
        .selectFrom('prepayment_advance')
        .select('entity_id')
        .where('voucher_id', '=', prepayVoucherId)
        .executeTakeFirst();
      expect(advance?.entity_id ?? null).toBeNull();
    });

    it('refuses to confirm a history that names another counterparty', async () => {
      const owner = await seedEntity('customer', 'Cust A');
      const other = await seedEntity('customer', 'Cust B');
      const prepayVoucherId = await seedForeignCustomerPrepaymentVoucher(
        10000,
        'EUR',
        '2025-01-15',
      );
      const invoiceVoucherId = await seedSalesInvoiceVoucher(
        10000,
        '2025-01-20',
      );
      await bindSalesInvoice(invoiceVoucherId, other, 10000);
      const clearingId = await seedClearingVoucher(invoiceVoucherId, 4000);

      await expect(
        prepaymentService.resolveAdvanceOwnership(prepayVoucherId, {
          entityId: owner,
          drawDowns: [{ allocationVoucherId: clearingId, invoiceVoucherId }],
        }),
      ).rejects.toThrow(`belongs to entity ${other}`);
    });
  });

  // ── List outstanding prepayments ───────────────────────────────────

  describe('listOutstandingPrepayments', () => {
    it('returns outstanding customer prepayments', async () => {
      const customerId = await seedEntity('customer', 'Cust A');
      const txn = await seedBankTransaction(50000);
      await prepaymentService.createCustomerPrepayment(txn.id, customerId);

      const outstanding = await prepaymentService.listOutstandingPrepayments();

      expect(outstanding.length).toBeGreaterThanOrEqual(1);
      const prepay = outstanding.find(
        (p) => p.accountCode === 'CUSTOMER_PREPAYMENTS',
      );
      expect(prepay).toBeDefined();
      expect(prepay!.originalAmount).toBe(50000);
      expect(prepay!.remaining).toBe(50000);
      expect(prepay!.drawnDown).toBe(0);
      expect(prepay!.entityId).toBe(customerId);
    });

    it('returns outstanding supplier prepayments', async () => {
      const supplierId = await seedEntity('supplier', 'Supp A');
      const txn = await seedBankTransaction(-25000);
      await prepaymentService.createSupplierPrepayment(txn.id, supplierId);

      const outstanding = await prepaymentService.listOutstandingPrepayments();

      const prepay = outstanding.find(
        (p) => p.accountCode === 'SUPPLIER_PREPAYMENTS',
      );
      expect(prepay).toBeDefined();
      expect(prepay!.originalAmount).toBe(25000);
      expect(prepay!.remaining).toBe(25000);
    });

    it('does NOT return fully drawn-down prepayments', async () => {
      const customerId = await seedEntity('customer', 'Cust A');
      const txn = await seedBankTransaction(30000);
      const prepayVoucher = await prepaymentService.createCustomerPrepayment(
        txn.id,
        customerId,
      );

      const invoiceVoucherId = await seedSalesInvoiceVoucher(
        50000,
        '2025-01-20',
      );
      await bindSalesInvoice(invoiceVoucherId, customerId, 50000);

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
      const customerId = await seedEntity('customer', 'Cust A');
      const txn = await seedBankTransaction(40000);
      const prepayVoucher = await prepaymentService.createCustomerPrepayment(
        txn.id,
        customerId,
      );

      const invoiceVoucherId = await seedSalesInvoiceVoucher(
        50000,
        '2025-01-20',
      );
      await bindSalesInvoice(invoiceVoucherId, customerId, 50000);

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
        OrgContextResolver,
        EntitiesService,
        LedgerBalanceService,
        OutstandingVoucherService,
        PrepaymentAllocationRepository,
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
