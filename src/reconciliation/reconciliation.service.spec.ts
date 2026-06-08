import { Test, TestingModule } from '@nestjs/testing';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import SqliteDb from 'better-sqlite3';
import { Database } from '../database/types';
import { migrations } from '../database/migrations';
import { AccountService } from '../ledger/account/account.service';
import { BankStatementService } from '../bank/bank-statement.service';
import { BankTransactionRepository } from '../bank/bank-transaction.repository';
import { EntitiesService } from '../entities/entities.service';
import { PostingService } from '../ledger/posting/posting.service';
import { LedgerBalanceService } from '../ledger/account/ledger-balance.service';
import { PeriodLockService } from '../reporting-periods/period-lock.service';
import { LedgerValidationService } from '../ledger/validation/ledger-validation.service';
import { OrganizationService } from '../organization/organization.service';
import { NullCountryPlugin } from '../plugins/null-country.plugin';
import { PluginLoader } from '../plugins/plugin-loader.service';
import { CurrencyService } from '../currency/currency.service';
import { CountryPlugin } from '../plugins/country-plugin.interface';
import { ReconciliationService } from './reconciliation.service';
import { OutstandingVoucherService } from './outstanding-voucher.service';
import { FXRealizedService } from './fx-realized.service';

/**
 * Integration test for the reconciliation matching engine.
 */
describe('ReconciliationService (integration)', () => {
  let db: Kysely<Database>;
  let reconciliationService: ReconciliationService;
  let bankStatementService: BankStatementService;
  let entitiesService: EntitiesService;
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
        BankTransactionRepository,
        BankStatementService,
        EntitiesService,
        LedgerValidationService,
        PostingService,
        PeriodLockService,
        OrganizationService,
        NullCountryPlugin,
        PluginLoader,
        CurrencyService,
        FXRealizedService,
        LedgerBalanceService,
        OutstandingVoucherService,
        ReconciliationService,
      ],
    }).compile();

    bankStatementService = module.get(BankStatementService);
    entitiesService = module.get(EntitiesService);
    reconciliationService = module.get(ReconciliationService);
  });

  afterEach(async () => {
    await db.destroy();
  });

  // ── Helpers ──────────────────────────────────────────────────────────

  async function seedCustomer(iban?: string) {
    const customer = await entitiesService.onboard({
      role: 'customer',
      country: 'IE',
      name: 'Test Customer Ltd',
      registrationKey: 'IE1234567T',
      goodsVsServices: 'services',
    });
    if (iban) {
      await entitiesService.addAlias(customer.id, {
        kind: 'iban',
        value: iban,
        confirmed: true,
      });
    }
    return customer;
  }

  async function seedSupplier(iban?: string) {
    const supplier = await entitiesService.onboard({
      role: 'supplier',
      country: 'IE',
      name: 'Test Supplier Co',
      registrationKey: 'IE9876543X',
      goodsVsServices: 'goods',
    });
    if (iban) {
      await entitiesService.addAlias(supplier.id, {
        kind: 'iban',
        value: iban,
        confirmed: true,
      });
    }
    return supplier;
  }

  async function seedSalesInvoiceVoucher(
    customerId: number,
    grossCents: number,
    invoiceNumber: string,
    taxPointDate: string,
  ): Promise<number> {
    const now = Math.floor(Date.now() / 1000);
    voucherCounter++;

    const si = await db
      .insertInto('sales_invoice')
      .values({
        customer_id: customerId,
        invoice_number: invoiceNumber,
        gross_amount: grossCents,
        vat_amount: 0,
        currency: 'EUR',
        tax_point_date: taxPointDate,
        due_date: taxPointDate,
        status: 'posted',
        voucher_id: null,
        created_at: now,
        updated_at: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    const voucher = await db
      .insertInto('voucher')
      .values({
        voucher_number: `V-2025-${String(voucherCounter).padStart(6, '0')}`,
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

    await db
      .updateTable('sales_invoice')
      .set({ voucher_id: voucher.id })
      .where('id', '=', si.id)
      .execute();

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
    supplierId: number,
    grossCents: number,
    taxPointDate: string,
  ): Promise<number> {
    const now = Math.floor(Date.now() / 1000);
    voucherCounter++;

    const exp = await db
      .insertInto('expense')
      .values({
        document_id: null,
        supplier_id: supplierId,
        category: 'software',
        gross_amount: grossCents,
        vat_amount: 0,
        currency: 'EUR',
        tax_point_date: taxPointDate,
        status: 'posted',
        voucher_id: null,
        created_at: now,
        updated_at: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    const voucher = await db
      .insertInto('voucher')
      .values({
        voucher_number: `V-2025-${String(voucherCounter).padStart(6, '0')}`,
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

    await db
      .updateTable('expense')
      .set({ voucher_id: voucher.id })
      .where('id', '=', exp.id)
      .execute();

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

  async function seedBankStatement(
    transactions: Array<{
      transaction_date: string;
      description?: string;
      amount: number;
      reference?: string;
      counterparty_iban?: string;
      counterparty_descriptor?: string;
    }>,
  ) {
    return bankStatementService.createStatement({
      account_code: 'BANK_EUR',
      start_date: '2025-01-01',
      end_date: '2025-01-31',
      transactions: transactions.map((t) => ({
        transaction_date: t.transaction_date,
        description: t.description ?? null,
        amount: t.amount,
        currency: 'EUR',
        reference: t.reference ?? null,
        counterparty_iban: t.counterparty_iban ?? null,
        counterparty_descriptor: t.counterparty_descriptor ?? null,
      })),
    });
  }

  // ── Tests ────────────────────────────────────────────────────────────

  describe('parseTransactionTokens', () => {
    it('extracts invoice number from reference field', () => {
      const tokens = reconciliationService.parseTransactionTokens({
        description: null,
        reference: 'INV-12345',
        counterparty_iban: null,
        counterparty_descriptor: null,
      });
      expect(tokens.invoiceNumbers).toContain('INV-12345');
    });

    it('extracts invoice number from description field', () => {
      const tokens = reconciliationService.parseTransactionTokens({
        description: 'Payment for INV-99887',
        reference: null,
        counterparty_iban: null,
        counterparty_descriptor: null,
      });
      expect(tokens.invoiceNumbers).toContain('INV-99887');
    });

    it('extracts IBAN from counterparty_iban field', () => {
      const tokens = reconciliationService.parseTransactionTokens({
        description: null,
        reference: null,
        counterparty_iban: 'IE29AIBK93115212345678',
        counterparty_descriptor: null,
      });
      expect(tokens.counterpartyIban).toBe('IE29AIBK93115212345678');
    });

    it('extracts IBAN from description when counterparty_iban is null', () => {
      const tokens = reconciliationService.parseTransactionTokens({
        description: 'Transfer to IE29AIBK93115212345678',
        reference: null,
        counterparty_iban: null,
        counterparty_descriptor: null,
      });
      expect(tokens.counterpartyIban).toBe('IE29AIBK93115212345678');
    });

    it('extracts merchant descriptor when no IBAN present', () => {
      const tokens = reconciliationService.parseTransactionTokens({
        description: 'Card purchase at AMAZON EU',
        reference: null,
        counterparty_iban: null,
        counterparty_descriptor: 'AMAZON EU',
      });
      expect(tokens.merchantDescriptor).toBe('AMAZON EU');
      expect(tokens.counterpartyIban).toBeNull();
    });

    it('extracts multiple invoice numbers from one line', () => {
      const tokens = reconciliationService.parseTransactionTokens({
        description: 'Payment for INV-100 and INV-200',
        reference: null,
        counterparty_iban: null,
        counterparty_descriptor: null,
      });
      expect(tokens.invoiceNumbers).toContain('INV-100');
      expect(tokens.invoiceNumbers).toContain('INV-200');
    });
  });

  describe('proposeMatches — invoice number signal', () => {
    it('matches incoming transaction to AR voucher by invoice number in reference', async () => {
      const customer = await seedCustomer();
      const voucherId = await seedSalesInvoiceVoucher(
        customer.id,
        50000,
        'INV-10001',
        '2025-01-10',
      );

      const stmt = await seedBankStatement([
        {
          transaction_date: '2025-01-12',
          description: 'Customer payment',
          amount: 50000,
          reference: 'INV-10001',
        },
      ]);

      const proposals = await reconciliationService.proposeMatches(
        stmt.statement.id,
      );

      expect(proposals.length).toBeGreaterThanOrEqual(1);
      const match = proposals.find((p) => p.voucherId === voucherId);
      expect(match).toBeDefined();
      expect(match!.signal).toBe('invoice_number');
      expect(match!.confidence).toBe('high');
      expect(match!.matchType).toBe('exact');
      expect(match!.amountMatched).toBe(50000);
    });

    it('does NOT emit invoice_number proposals for outgoing/AP transactions (no invoice key on expenses)', async () => {
      const supplier = await seedSupplier();
      // Two posted expense vouchers with the SAME gross amount, neither tied to
      // any invoice number.
      await seedExpenseVoucher(supplier.id, 42000, '2025-01-10');
      await seedExpenseVoucher(supplier.id, 42000, '2025-01-10');

      const stmt = await seedBankStatement([
        {
          transaction_date: '2025-01-12',
          description: 'Supplier payment',
          amount: -42000,
          reference: 'INV-1 INV-2',
        },
      ]);

      const proposals = await reconciliationService.proposeMatches(
        stmt.statement.id,
      );

      const invoiceMatches = proposals.filter(
        (p) => p.signal === 'invoice_number',
      );
      expect(invoiceMatches).toHaveLength(0);
    });
  });

  describe('proposeMatches — counterparty signal', () => {
    it('matches incoming transaction to AR voucher by counterparty IBAN', async () => {
      const customer = await seedCustomer('IE29AIBK93115212345678');
      const voucherId = await seedSalesInvoiceVoucher(
        customer.id,
        75000,
        'INV-20001',
        '2025-01-10',
      );

      const stmt = await seedBankStatement([
        {
          transaction_date: '2025-01-12',
          description: 'Payment received',
          amount: 75000,
          counterparty_iban: 'IE29AIBK93115212345678',
        },
      ]);

      const proposals = await reconciliationService.proposeMatches(
        stmt.statement.id,
      );

      expect(proposals.length).toBeGreaterThanOrEqual(1);
      const match = proposals.find((p) => p.voucherId === voucherId);
      expect(match).toBeDefined();
      expect(match!.signal).toBe('counterparty');
      expect(match!.amountMatched).toBe(75000);
    });

    it('matches outgoing transaction to AP voucher by counterparty IBAN', async () => {
      const supplier = await seedSupplier('DE89370400440532013000');
      const voucherId = await seedExpenseVoucher(
        supplier.id,
        42000,
        '2025-01-10',
      );

      const stmt = await seedBankStatement([
        {
          transaction_date: '2025-01-12',
          description: 'Supplier payment',
          amount: -42000,
          counterparty_iban: 'DE89370400440532013000',
        },
      ]);

      const proposals = await reconciliationService.proposeMatches(
        stmt.statement.id,
      );

      expect(proposals.length).toBeGreaterThanOrEqual(1);
      const match = proposals.find((p) => p.voucherId === voucherId);
      expect(match).toBeDefined();
      expect(match!.signal).toBe('counterparty');
      expect(match!.amountMatched).toBe(42000);
    });
  });

  describe('proposeMatches — amount + date signal (fallback)', () => {
    it('matches incoming transaction by amount and date window when no invoice or counterparty', async () => {
      const customer = await seedCustomer();
      const voucherId = await seedSalesInvoiceVoucher(
        customer.id,
        25000,
        'INV-30001',
        '2025-01-10',
      );

      const stmt = await seedBankStatement([
        {
          transaction_date: '2025-01-12',
          description: 'Unknown payment',
          amount: 25000,
        },
      ]);

      const proposals = await reconciliationService.proposeMatches(
        stmt.statement.id,
      );

      expect(proposals.length).toBeGreaterThanOrEqual(1);
      const match = proposals.find((p) => p.voucherId === voucherId);
      expect(match).toBeDefined();
      expect(match!.signal).toBe('amount_date');
      expect(match!.confidence).toBe('low');
    });

    it('does NOT match when date is outside ±7 day window', async () => {
      const customer = await seedCustomer();
      await seedSalesInvoiceVoucher(
        customer.id,
        15000,
        'INV-40001',
        '2025-01-01',
      );

      const stmt = await seedBankStatement([
        {
          transaction_date: '2025-01-20',
          description: 'Late payment',
          amount: 15000,
        },
      ]);

      const proposals = await reconciliationService.proposeMatches(
        stmt.statement.id,
      );
      const match = proposals.find((p) => p.signal === 'amount_date');
      expect(match).toBeUndefined();
    });
  });

  describe('N:M matching', () => {
    it('one transaction can match two vouchers (partial + partial)', async () => {
      const customer = await seedCustomer();
      const voucherId1 = await seedSalesInvoiceVoucher(
        customer.id,
        30000,
        'INV-50001',
        '2025-01-10',
      );
      const voucherId2 = await seedSalesInvoiceVoucher(
        customer.id,
        20000,
        'INV-50002',
        '2025-01-10',
      );

      const stmt = await seedBankStatement([
        {
          transaction_date: '2025-01-12',
          description: 'Bulk payment',
          amount: 50000,
          reference: 'INV-50001 INV-50002',
        },
      ]);

      const proposals = await reconciliationService.proposeMatches(
        stmt.statement.id,
      );

      const match1 = proposals.find((p) => p.voucherId === voucherId1);
      const match2 = proposals.find((p) => p.voucherId === voucherId2);
      expect(match1).toBeDefined();
      expect(match2).toBeDefined();
      expect(match1!.amountMatched).toBe(30000);
      expect(match2!.amountMatched).toBe(20000);
    });

    it('one voucher can be matched by multiple transactions (partial payments)', async () => {
      const customer = await seedCustomer();
      const voucherId = await seedSalesInvoiceVoucher(
        customer.id,
        100000,
        'INV-60001',
        '2025-01-10',
      );

      const stmt1 = await seedBankStatement([
        {
          transaction_date: '2025-01-12',
          description: 'Partial payment 1',
          amount: 40000,
          reference: 'INV-60001',
        },
      ]);

      const proposals1 = await reconciliationService.proposeMatches(
        stmt1.statement.id,
      );
      expect(proposals1.length).toBeGreaterThanOrEqual(1);
      expect(proposals1[0].voucherId).toBe(voucherId);
      expect(proposals1[0].amountMatched).toBe(40000);
      expect(proposals1[0].matchType).toBe('partial');

      await reconciliationService.executeMatch(proposals1);

      const stmt2 = await seedBankStatement([
        {
          transaction_date: '2025-01-15',
          description: 'Partial payment 2',
          amount: 60000,
          reference: 'INV-60001',
        },
      ]);

      const proposals2 = await reconciliationService.proposeMatches(
        stmt2.statement.id,
      );
      const match2 = proposals2.find((p) => p.voucherId === voucherId);
      expect(match2).toBeDefined();
      expect(match2!.amountMatched).toBe(60000);
      expect(match2!.matchType).toBe('exact');
    });
  });

  describe('executeMatch', () => {
    it('creates reconciliation_match records from proposals', async () => {
      const customer = await seedCustomer();
      const voucherId = await seedSalesInvoiceVoucher(
        customer.id,
        50000,
        'INV-70001',
        '2025-01-10',
      );

      const stmt = await seedBankStatement([
        {
          transaction_date: '2025-01-12',
          description: 'Payment',
          amount: 50000,
          reference: 'INV-70001',
        },
      ]);

      const proposals = await reconciliationService.proposeMatches(
        stmt.statement.id,
      );
      expect(proposals.length).toBeGreaterThanOrEqual(1);

      const result = await reconciliationService.executeMatch(proposals);
      expect(result.records.length).toBe(proposals.length);

      const dbRecords = await db
        .selectFrom('reconciliation_match')
        .selectAll()
        .where('voucher_id', '=', voucherId)
        .execute();

      expect(dbRecords.length).toBe(result.records.length);
      expect(dbRecords[0].match_type).toBe('exact');
      expect(dbRecords[0].amount_matched).toBe(50000);
    });

    it('rejects empty proposals array', async () => {
      await expect(reconciliationService.executeMatch([])).rejects.toThrow();
    });

    it('rejects proposal with non-existent transaction', async () => {
      await expect(
        reconciliationService.executeMatch([
          {
            bankTransactionId: 99999,
            voucherId: 1,
            matchType: 'exact',
            amountMatched: 1000,
            confidence: 'high',
            signal: 'invoice_number',
          },
        ]),
      ).rejects.toThrow();
    });

    it('rejects proposal with non-existent voucher', async () => {
      const stmt = await seedBankStatement([
        {
          transaction_date: '2025-01-12',
          description: 'Payment',
          amount: 10000,
        },
      ]);

      await expect(
        reconciliationService.executeMatch([
          {
            bankTransactionId: stmt.transactions[0].id,
            voucherId: 99999,
            matchType: 'exact',
            amountMatched: 10000,
            confidence: 'high',
            signal: 'invoice_number',
          },
        ]),
      ).rejects.toThrow();
    });
  });

  describe('incoming vs outgoing direction', () => {
    it('incoming (positive amount) finds AR candidates', async () => {
      const customer = await seedCustomer();
      await seedSalesInvoiceVoucher(
        customer.id,
        60000,
        'INV-80001',
        '2025-01-10',
      );

      const stmt = await seedBankStatement([
        {
          transaction_date: '2025-01-12',
          description: 'Incoming payment',
          amount: 60000,
        },
      ]);

      const proposals = await reconciliationService.proposeMatches(
        stmt.statement.id,
      );
      for (const p of proposals) {
        expect(p.amountMatched).toBeGreaterThan(0);
      }
    });

    it('outgoing (negative amount) finds AP candidates', async () => {
      const supplier = await seedSupplier();
      await seedExpenseVoucher(supplier.id, 35000, '2025-01-10');

      const stmt = await seedBankStatement([
        {
          transaction_date: '2025-01-12',
          description: 'Outgoing payment',
          amount: -35000,
        },
      ]);

      const proposals = await reconciliationService.proposeMatches(
        stmt.statement.id,
      );
      for (const p of proposals) {
        expect(p.amountMatched).toBeGreaterThan(0);
      }
    });
  });

  describe('match type determination', () => {
    it('exact match when transaction amount equals voucher remaining balance', async () => {
      const customer = await seedCustomer();
      await seedSalesInvoiceVoucher(
        customer.id,
        45000,
        'INV-90001',
        '2025-01-10',
      );

      const stmt = await seedBankStatement([
        {
          transaction_date: '2025-01-12',
          description: 'Full payment',
          amount: 45000,
          reference: 'INV-90001',
        },
      ]);

      const proposals = await reconciliationService.proposeMatches(
        stmt.statement.id,
      );
      const match = proposals.find((p) => p.matchType === 'exact');
      expect(match).toBeDefined();
    });

    it('partial match when transaction amount is less than voucher balance', async () => {
      const customer = await seedCustomer();
      await seedSalesInvoiceVoucher(
        customer.id,
        80000,
        'INV-90002',
        '2025-01-10',
      );

      const stmt = await seedBankStatement([
        {
          transaction_date: '2025-01-12',
          description: 'Partial payment',
          amount: 30000,
          reference: 'INV-90002',
        },
      ]);

      const proposals = await reconciliationService.proposeMatches(
        stmt.statement.id,
      );
      const match = proposals.find((p) => p.signal === 'invoice_number');
      expect(match).toBeDefined();
      expect(match!.matchType).toBe('partial');
      expect(match!.amountMatched).toBe(30000);
    });
  });

  describe('already-matched tracking', () => {
    it('does not propose matches for fully matched vouchers', async () => {
      const customer = await seedCustomer();
      const voucherId = await seedSalesInvoiceVoucher(
        customer.id,
        50000,
        'INV-95001',
        '2025-01-10',
      );

      const stmt = await seedBankStatement([
        {
          transaction_date: '2025-01-05',
          description: 'Earlier payment',
          amount: 50000,
        },
      ]);

      const now = Math.floor(Date.now() / 1000);
      await db
        .insertInto('reconciliation_match')
        .values({
          bank_transaction_id: stmt.transactions[0].id,
          voucher_id: voucherId,
          match_type: 'exact',
          amount_matched: 50000,
          created_at: now,
        })
        .execute();

      const stmt2 = await seedBankStatement([
        {
          transaction_date: '2025-01-12',
          description: 'Duplicate payment',
          amount: 50000,
          reference: 'INV-95001',
        },
      ]);

      const proposals = await reconciliationService.proposeMatches(
        stmt2.statement.id,
      );
      const match = proposals.find((p) => p.voucherId === voucherId);
      expect(match).toBeUndefined();
    });
  });

  describe('getRemainingVoucherBalance — AR/AP netting', () => {
    it('nets an AR debit against an AP credit on the same voucher to zero', async () => {
      const now = Math.floor(Date.now() / 1000);
      voucherCounter++;

      const voucher = await db
        .insertInto('voucher')
        .values({
          voucher_number: `V-2025-${String(voucherCounter).padStart(6, '0')}`,
          tax_point_date: '2025-01-10',
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

      const apAccount = await db
        .selectFrom('account')
        .select('id')
        .where('code', '=', 'AP')
        .executeTakeFirstOrThrow();

      // A contra/reclass voucher carrying both an AR debit and an AP credit
      // for the same base amount. These should net to zero, not sum to 20000.
      await db
        .insertInto('voucher_line')
        .values([
          {
            voucher_id: voucher.id,
            account_id: arAccount.id,
            amount: 10000,
            currency: 'EUR',
            base_amount: 10000,
            fx_rate: 1,
            vat_code: null,
            is_debit: 1,
          },
          {
            voucher_id: voucher.id,
            account_id: apAccount.id,
            amount: 10000,
            currency: 'EUR',
            base_amount: 10000,
            fx_rate: 1,
            vat_code: null,
            is_debit: 0,
          },
        ])
        .execute();

      const remaining =
        await reconciliationService.getRemainingVoucherBalanceForTest(
          voucher.id,
        );

      expect(remaining).toBe(0);
    });
  });
});

/**
 * Currency-normalised matching (D7).
 *
 * The bank transaction amount is in the transaction's OWN currency (e.g. USD),
 * while a voucher's remaining balance is `voucher_line.base_amount` in BASE
 * currency (e.g. EUR). Matching must convert the bank amount to base ONCE (via
 * the country plugin's reference rate) before comparing against
 * `remainingBalance` so that a USD receipt settling a EUR-base invoice reports
 * exact/high and `amountMatched` is the BASE amount — not the raw USD amount.
 *
 * NullCountryPlugin throws on real cross-currency pairs, so a fake PluginLoader
 * is required (mirrors fx-realized / personal-disposition specs).
 */
describe('ReconciliationService — currency-normalised matching (D7)', () => {
  let db: Kysely<Database>;
  let reconciliationService: ReconciliationService;
  let voucherCounter = 0;

  /** Fake plugin: USD→EUR = 0.9; same-currency = 1.0; base currency EUR. */
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
        BankTransactionRepository,
        BankStatementService,
        EntitiesService,
        LedgerValidationService,
        PostingService,
        PeriodLockService,
        OrganizationService,
        NullCountryPlugin,
        PluginLoader,
        CurrencyService,
        FXRealizedService,
        LedgerBalanceService,
        OutstandingVoucherService,
        ReconciliationService,
      ],
    })
      .overrideProvider(PluginLoader)
      .useValue(fakeLoader)
      .compile();

    reconciliationService = module.get(ReconciliationService);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('converts a USD receipt to base EUR before matching a EUR-base AR invoice (exact/high, amountMatched in base)', async () => {
    const now = Math.floor(Date.now() / 1000);
    voucherCounter++;

    // EUR-base AR invoice: remaining base balance 1 400 EUR.
    const customer = await db
      .insertInto('entity')
      .values({
        role: 'customer',
        country: 'IE',
        name: 'FX Customer Ltd',
        goods_vs_services: 'services',
        created_at: now,
        updated_at: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    const si = await db
      .insertInto('sales_invoice')
      .values({
        customer_id: customer.id,
        invoice_number: 'INV-14001',
        gross_amount: 1_400,
        vat_amount: 0,
        currency: 'EUR',
        tax_point_date: '2025-01-10',
        due_date: '2025-01-10',
        status: 'posted',
        voucher_id: null,
        created_at: now,
        updated_at: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    const voucher = await db
      .insertInto('voucher')
      .values({
        voucher_number: `V-2025-${String(voucherCounter).padStart(6, '0')}`,
        tax_point_date: '2025-01-10',
        posted_at: now,
        previous_hash: null,
        reverses_id: null,
        corrects_object_type: null,
        corrects_object_id: null,
        reason: null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await db
      .updateTable('sales_invoice')
      .set({ voucher_id: voucher.id })
      .where('id', '=', si.id)
      .execute();

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
          amount: 1_400,
          currency: 'EUR',
          base_amount: 1_400,
          fx_rate: 1,
          vat_code: null,
          is_debit: 1,
        },
        {
          voucher_id: voucher.id,
          account_id: revenueAccount.id,
          amount: 1_400,
          currency: 'EUR',
          base_amount: 1_400,
          fx_rate: 1,
          vat_code: null,
          is_debit: 0,
        },
      ])
      .execute();

    // Bank statement on a USD account; incoming 1 555 USD.
    // 1 555 USD × 0.9 (USD→EUR) = 1 399.5 → round → 1 400 EUR == remaining base.
    const usdAccount = await db
      .selectFrom('account')
      .select('id')
      .where('code', '=', 'BANK_USD')
      .executeTakeFirstOrThrow();

    const statement = await db
      .insertInto('bank_statement')
      .values({
        account_id: usdAccount.id,
        start_date: '2025-01-01',
        end_date: '2025-01-31',
        uploaded_at: now,
        file_path: null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await db
      .insertInto('bank_transaction')
      .values({
        statement_id: statement.id,
        transaction_date: '2025-01-12',
        description: 'USD receipt for INV-14001',
        amount: 1_555, // 1 555 USD incoming
        currency: 'USD',
        source_currency: null,
        source_amount: null,
        fx_rate: null,
        reference: 'INV-14001',
        counterparty_iban: null,
        counterparty_descriptor: null,
        status: 'open',
        created_at: now,
      })
      .execute();

    const proposals = await reconciliationService.proposeMatches(statement.id);

    const match = proposals.find((p) => p.voucherId === voucher.id);
    expect(match).toBeDefined();
    expect(match!.signal).toBe('invoice_number');
    // After USD→EUR conversion the base amount (1 400) EXACTLY equals the
    // remaining base balance → exact / high.
    expect(match!.matchType).toBe('exact');
    expect(match!.confidence).toBe('high');
    // amountMatched is in BASE currency (1 400 EUR), NOT the raw 1 555 USD.
    expect(match!.amountMatched).toBe(1_400);
  });
});
