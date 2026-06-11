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
import { EstoniaCountryPlugin } from '../plugins/estonia-country.plugin';
import { PluginLoader } from '../plugins/plugin-loader.service';
import { CurrencyService } from '../currency/currency.service';
import { CountryPlugin } from '../plugins/country-plugin.interface';
import { ReconciliationService } from './reconciliation.service';
import { OutstandingVoucherService } from './outstanding-voucher.service';
import { FXRealizedService } from './fx-realized.service';

/**
 * Integration test for FX realized auto-posting (Task 25 / ADR-0004).
 *
 * Real-DI: in-memory SQLite with full migration chain, real PostingService,
 * real FXRealizedService — no stubs.
 */
describe('FXRealizedService (integration)', () => {
  let db: Kysely<Database>;
  let fxRealizedService: FXRealizedService;
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

    // Seed voucher_sequence so the posting service generates numbers that
    // don't collide with manually-inserted test vouchers (V-2025-000001…).
    await db
      .insertInto('voucher_sequence')
      .values({ year: '2025', last_number: 100 })
      .execute();

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
        EstoniaCountryPlugin,
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
    fxRealizedService = module.get(FXRealizedService);
    reconciliationService = module.get(ReconciliationService);
  });

  afterEach(async () => {
    await db.destroy();
  });

  // ── Helpers ──────────────────────────────────────────────────────────

  async function seedCustomer() {
    return entitiesService.onboard({
      role: 'customer',
      country: 'IE',
      name: 'Test Customer Ltd',
      registrationKey: 'IE1234567T',
      goodsVsServices: 'services',
    });
  }

  /**
   * Seed a foreign-currency (USD) sales-invoice voucher.
   *
   * @param fxRate  Booking rate: how many base-currency units per 1 USD.
   *                E.g. 7.0 → 10 000 USD = 70 000 base cents.
   */
  async function seedForeignCurrencySalesInvoiceVoucher(
    customerId: number,
    grossForeignCents: number,
    fxRate: number,
    invoiceNumber: string,
    taxPointDate: string,
  ): Promise<number> {
    const now = Math.floor(Date.now() / 1000);
    voucherCounter++;

    const baseAmount = Math.round(grossForeignCents * fxRate);

    const si = await db
      .insertInto('sales_invoice')
      .values({
        customer_id: customerId,
        invoice_number: invoiceNumber,
        gross_amount: grossForeignCents,
        vat_amount: 0,
        currency: 'USD',
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
          amount: grossForeignCents,
          currency: 'USD',
          base_amount: baseAmount,
          fx_rate: fxRate,
          vat_code: null,
          is_debit: 1,
        },
        {
          voucher_id: voucher.id,
          account_id: revenueAccount.id,
          amount: grossForeignCents,
          currency: 'USD',
          base_amount: baseAmount,
          fx_rate: fxRate,
          vat_code: null,
          is_debit: 0,
        },
      ])
      .execute();

    return voucher.id;
  }

  /**
   * Seed a foreign-currency (USD) purchase-invoice / AP voucher.
   *
   * Mirrors {@link seedForeignCurrencySalesInvoiceVoucher} but for the
   * payable (outgoing) direction: Dr EXPENSE / Cr AP.
   *
   * @param fxRate  Booking rate: how many base-currency units per 1 USD.
   */
  async function seedForeignCurrencyPurchaseInvoiceVoucher(
    grossForeignCents: number,
    fxRate: number,
    taxPointDate: string,
  ): Promise<number> {
    const now = Math.floor(Date.now() / 1000);
    voucherCounter++;

    const baseAmount = Math.round(grossForeignCents * fxRate);

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
          amount: grossForeignCents,
          currency: 'USD',
          base_amount: baseAmount,
          fx_rate: fxRate,
          vat_code: null,
          is_debit: 1,
        },
        {
          voucher_id: voucher.id,
          account_id: apAccount.id,
          amount: grossForeignCents,
          currency: 'USD',
          base_amount: baseAmount,
          fx_rate: fxRate,
          vat_code: null,
          is_debit: 0,
        },
      ])
      .execute();

    return voucher.id;
  }

  /**
   * Seed a bank statement with a single foreign-leg transaction.
   *
   * @param sourceAmount Cents in the source currency (e.g. USD).
   * @param fxRate       The bank's actual conversion rate.
   * @param currency     The account currency (e.g. 'EUR').
   */
  async function seedBankStatementWithForeignLeg(params: {
    sourceCurrency: string;
    sourceAmount: number;
    fxRate: number;
    currency?: string;
    description?: string;
    reference?: string;
    transactionDate?: string;
  }) {
    const currency = params.currency ?? 'EUR';
    // The bank-line amount = sourceAmount × fxRate (rounded to cents).
    const amount = Math.round(Math.abs(params.sourceAmount) * params.fxRate);
    const isIncoming = params.sourceAmount > 0;

    return bankStatementService.createStatement({
      account_code: 'BANK_EUR',
      start_date: '2025-01-01',
      end_date: '2025-01-31',
      transactions: [
        {
          transaction_date: params.transactionDate ?? '2025-01-12',
          description: params.description ?? 'Foreign payment received',
          amount: isIncoming ? amount : -amount,
          currency,
          source_currency: params.sourceCurrency,
          source_amount: params.sourceAmount,
          fx_rate: params.fxRate,
          reference: params.reference ?? null,
          counterparty_iban: null,
          counterparty_descriptor: null,
        },
      ],
    });
  }

  // ── Tests ────────────────────────────────────────────────────────────

  describe('computeAndPost — FX gain', () => {
    it('posts a gain voucher when bank settles at a better rate than booked', async () => {
      // Scenario: USD invoice booked at 7.0, bank settles at 7.14 → gain.
      // 10 000 USD × 7.0 = 70 000 base (booked)
      // 10 000 USD × 7.14 = 71 400 base (actual)
      // realized = 70 000 − 71 400 = −1 400 → gain of 1 400

      const customer = await seedCustomer();
      const voucherId = await seedForeignCurrencySalesInvoiceVoucher(
        customer.id,
        10_000, // 10 000 USD
        7.0, // booked rate
        'INV-FX-001',
        '2025-01-10',
      );

      const stmt = await seedBankStatementWithForeignLeg({
        sourceCurrency: 'USD',
        sourceAmount: 10_000,
        fxRate: 7.14, // bank's better rate
        reference: 'INV-FX-001',
      });

      const bankTxnId = stmt.transactions[0].id;

      const result = await fxRealizedService.computeAndPost(
        voucherId,
        bankTxnId,
        70_000, // matchedAmount = booked base
      );

      expect(result.status).toBe('posted');
      expect(result.voucher).toBeDefined();
      expect(result.voucher!.reason).toContain('Realized FX');

      const lines = result.voucher!.lines;
      expect(lines.length).toBe(2);

      // Gain: Dr BANK_EUR / Cr FX_GAIN_LOSS
      const bankLine = lines.find((l) => l.is_debit);
      const fxLine = lines.find((l) => !l.is_debit);

      expect(bankLine).toBeDefined();
      expect(bankLine!.amount).toBe(1_400);
      expect(bankLine!.base_amount).toBe(1_400);

      expect(fxLine).toBeDefined();
      expect(fxLine!.amount).toBe(1_400);
      expect(fxLine!.base_amount).toBe(1_400);

      // Verify the FX_GAIN_LOSS account was used.
      const fxAccount = await db
        .selectFrom('account')
        .select('id')
        .where('code', '=', 'FX_GAIN_LOSS')
        .executeTakeFirstOrThrow();
      expect(fxLine!.account_id).toBe(fxAccount.id);
    });
  });

  describe('computeAndPost — partial match (proportional)', () => {
    it('scales actualBase to the matched proportion of the voucher booked base', async () => {
      // AR voucher booked at full base 70 000 (10 000 USD × 7.0).
      // Bank settles the FULL foreign leg at 7.14 → actualInTxnCcy 71 400.
      // But only 30 000 of the 70 000 booked base is matched here.
      // proportion = 30 000 / 70 000 = 3/7
      // actualBaseForMatch = round(71 400 × 3/7) = 30 600
      // realized = 30 000 − 30 600 = −600 → small GAIN of 600 (NOT 41 400).
      const customer = await seedCustomer();
      const voucherId = await seedForeignCurrencySalesInvoiceVoucher(
        customer.id,
        10_000, // 10 000 USD → 70 000 base booked
        7.0,
        'INV-FX-PARTIAL-001',
        '2025-01-10',
      );

      const stmt = await seedBankStatementWithForeignLeg({
        sourceCurrency: 'USD',
        sourceAmount: 10_000,
        fxRate: 7.14,
        reference: 'INV-FX-PARTIAL-001',
      });

      const bankTxnId = stmt.transactions[0].id;

      const result = await fxRealizedService.computeAndPost(
        voucherId,
        bankTxnId,
        30_000, // partial matchedAmount
      );

      expect(result.status).toBe('posted');
      const lines = result.voucher!.lines;
      expect(lines.length).toBe(2);

      // Incoming (AR) settlement, realized < 0 → gain: Dr BANK / Cr FX_GAIN_LOSS.
      const bankLine = lines.find((l) => l.is_debit)!;
      const fxLine = lines.find((l) => !l.is_debit)!;

      // The bug produced 41 400 (30 000 − 71 400); the fix yields 600.
      expect(fxLine.base_amount).toBe(600);
      expect(bankLine.base_amount).toBe(600);

      const fxAccount = await db
        .selectFrom('account')
        .select('id')
        .where('code', '=', 'FX_GAIN_LOSS')
        .executeTakeFirstOrThrow();
      const bankAccount = await db
        .selectFrom('account')
        .select('id')
        .where('code', '=', 'BANK_EUR')
        .executeTakeFirstOrThrow();
      expect(fxLine.account_id).toBe(fxAccount.id);
      expect(bankLine.account_id).toBe(bankAccount.id);
    });
  });

  describe('computeAndPost — FX loss', () => {
    it('posts a loss voucher when bank settles at a worse rate than booked', async () => {
      // Scenario: USD invoice booked at 7.0, bank settles at 6.86 → loss.
      // 10 000 USD × 7.0 = 70 000 base (booked)
      // 10 000 USD × 6.86 = 68 600 base (actual)
      // realized = 70 000 − 68 600 = 1 400 → loss of 1 400

      const customer = await seedCustomer();
      const voucherId = await seedForeignCurrencySalesInvoiceVoucher(
        customer.id,
        10_000,
        7.0,
        'INV-FX-002',
        '2025-01-10',
      );

      const stmt = await seedBankStatementWithForeignLeg({
        sourceCurrency: 'USD',
        sourceAmount: 10_000,
        fxRate: 6.86, // bank's worse rate
        reference: 'INV-FX-002',
      });

      const bankTxnId = stmt.transactions[0].id;

      const result = await fxRealizedService.computeAndPost(
        voucherId,
        bankTxnId,
        70_000,
      );

      expect(result.status).toBe('posted');
      expect(result.voucher).toBeDefined();

      const lines = result.voucher!.lines;
      expect(lines.length).toBe(2);

      // Loss: Dr FX_GAIN_LOSS / Cr BANK_EUR
      const fxLine = lines.find((l) => l.is_debit);
      const bankLine = lines.find((l) => !l.is_debit);

      expect(fxLine).toBeDefined();
      expect(fxLine!.amount).toBe(1_400);

      expect(bankLine).toBeDefined();
      expect(bankLine!.amount).toBe(1_400);
    });
  });

  describe('computeAndPost — AP (outgoing) settlement', () => {
    it('posts a LOSS when paying MORE base than booked on an outgoing AP settlement', async () => {
      // Scenario: USD purchase invoice booked at 7.0, bank pays at 7.14.
      // 10 000 USD × 7.0 = 70 000 base (booked AP)
      // 10 000 USD × 7.14 = 71 400 base (actually paid)
      // We paid 1 400 MORE base than booked → this is a LOSS.
      const voucherId = await seedForeignCurrencyPurchaseInvoiceVoucher(
        10_000,
        7.0,
        '2025-01-10',
      );

      // Outgoing payment: negative source_amount → negative bank amount.
      const stmt = await seedBankStatementWithForeignLeg({
        sourceCurrency: 'USD',
        sourceAmount: -10_000,
        fxRate: 7.14,
        description: 'Foreign supplier payment',
        reference: 'BILL-FX-001',
      });

      const bankTxnId = stmt.transactions[0].id;

      const result = await fxRealizedService.computeAndPost(
        voucherId,
        bankTxnId,
        70_000, // matchedAmount = booked base
      );

      expect(result.status).toBe('posted');
      expect(result.voucher).toBeDefined();

      const lines = result.voucher!.lines;
      expect(lines.length).toBe(2);

      // LOSS: Dr FX_GAIN_LOSS / Cr BANK_EUR
      const fxLine = lines.find((l) => l.is_debit);
      const bankLine = lines.find((l) => !l.is_debit);

      const fxAccount = await db
        .selectFrom('account')
        .select('id')
        .where('code', '=', 'FX_GAIN_LOSS')
        .executeTakeFirstOrThrow();
      const bankAccount = await db
        .selectFrom('account')
        .select('id')
        .where('code', '=', 'BANK_EUR')
        .executeTakeFirstOrThrow();

      // FX_GAIN_LOSS must be DEBITED (the loss).
      expect(fxLine).toBeDefined();
      expect(fxLine!.account_id).toBe(fxAccount.id);
      expect(fxLine!.base_amount).toBe(1_400);

      // BANK must be CREDITED.
      expect(bankLine).toBeDefined();
      expect(bankLine!.account_id).toBe(bankAccount.id);
      expect(bankLine!.base_amount).toBe(1_400);
    });
  });

  describe('computeAndPost — no FX', () => {
    it('returns no_fx when same currency (no foreign leg)', async () => {
      const customer = await seedCustomer();
      const voucherId = await seedForeignCurrencySalesInvoiceVoucher(
        customer.id,
        10_000,
        7.0,
        'INV-FX-003',
        '2025-01-10',
      );

      // Same-currency bank transaction (no source_currency).
      const stmt = await bankStatementService.createStatement({
        account_code: 'BANK_EUR',
        start_date: '2025-01-01',
        end_date: '2025-01-31',
        transactions: [
          {
            transaction_date: '2025-01-12',
            description: 'EUR payment',
            amount: 70_000,
            currency: 'EUR',
            reference: 'INV-FX-003',
          },
        ],
      });

      const bankTxnId = stmt.transactions[0].id;

      const result = await fxRealizedService.computeAndPost(
        voucherId,
        bankTxnId,
        70_000,
      );

      expect(result.status).toBe('no_fx');
    });

    it('returns no_fx when booked base equals actual base', async () => {
      const customer = await seedCustomer();
      const voucherId = await seedForeignCurrencySalesInvoiceVoucher(
        customer.id,
        10_000,
        7.0,
        'INV-FX-004',
        '2025-01-10',
      );

      // Bank settles at the same rate as booked.
      const stmt = await seedBankStatementWithForeignLeg({
        sourceCurrency: 'USD',
        sourceAmount: 10_000,
        fxRate: 7.0, // same as booked
        reference: 'INV-FX-004',
      });

      const bankTxnId = stmt.transactions[0].id;

      const result = await fxRealizedService.computeAndPost(
        voucherId,
        bankTxnId,
        70_000,
      );

      expect(result.status).toBe('no_fx');
    });
  });

  describe('computeAndPost — missing data', () => {
    it('returns missing_data when both source_amount and fx_rate are null', async () => {
      const customer = await seedCustomer();
      const voucherId = await seedForeignCurrencySalesInvoiceVoucher(
        customer.id,
        10_000,
        7.0,
        'INV-FX-005',
        '2025-01-10',
      );

      // Foreign leg declared but no conversion data.
      const stmt = await bankStatementService.createStatement({
        account_code: 'BANK_EUR',
        start_date: '2025-01-01',
        end_date: '2025-01-31',
        transactions: [
          {
            transaction_date: '2025-01-12',
            description: 'Foreign payment — missing data',
            amount: 70_000,
            currency: 'EUR',
            source_currency: 'USD',
            source_amount: null,
            fx_rate: null,
            reference: 'INV-FX-005',
          },
        ],
      });

      const bankTxnId = stmt.transactions[0].id;

      const result = await fxRealizedService.computeAndPost(
        voucherId,
        bankTxnId,
        70_000,
      );

      expect(result.status).toBe('missing_data');
      expect(result.message).toContain('lacks both source_amount and fx_rate');
    });
  });

  describe('FX on match activation', () => {
    it('posts the FX voucher when a foreign-currency match is activated', async () => {
      const customer = await seedCustomer();
      const voucherId = await seedForeignCurrencySalesInvoiceVoucher(
        customer.id,
        10_000,
        7.0,
        'INV-FX-006',
        '2025-01-10',
      );

      const stmt = await seedBankStatementWithForeignLeg({
        sourceCurrency: 'USD',
        sourceAmount: 10_000,
        fxRate: 7.14,
        reference: 'INV-FX-006',
      });

      const bankTxnId = stmt.transactions[0].id;

      const result = await reconciliationService.executeMatch([
        {
          bankTransactionId: bankTxnId,
          voucherId,
          matchType: 'exact',
          amountMatched: 70_000,
          confidence: 'high',
          signal: 'invoice_number',
        },
      ]);

      // Staging creates the draft but posts no FX.
      expect(result.records.length).toBe(1);

      // FX posts when the match is ACTIVATED (the approval seam).
      const { fxVoucherId } = await reconciliationService.activateMatch(
        result.records[0].id,
      );
      expect(fxVoucherId).not.toBeNull();

      const persistedLines = await db
        .selectFrom('voucher_line')
        .selectAll()
        .where('voucher_id', '=', fxVoucherId!)
        .execute();
      expect(persistedLines.length).toBe(2);

      // The FX voucher is recorded on the match so an unmatch can reverse it.
      const row = await db
        .selectFrom('reconciliation_match')
        .select('fx_voucher_id')
        .where('id', '=', result.records[0].id)
        .executeTakeFirstOrThrow();
      expect(row.fx_voucher_id).toBe(fxVoucherId);
    });

    it('posts no FX for a same-currency match', async () => {
      const customer = await seedCustomer();

      // EUR-denominated voucher (same as base currency).
      const now = Math.floor(Date.now() / 1000);
      voucherCounter++;
      const si = await db
        .insertInto('sales_invoice')
        .values({
          customer_id: customer.id,
          invoice_number: 'INV-FX-007',
          gross_amount: 50_000,
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
            amount: 50_000,
            currency: 'EUR',
            base_amount: 50_000,
            fx_rate: 1.0,
            vat_code: null,
            is_debit: 1,
          },
          {
            voucher_id: voucher.id,
            account_id: revenueAccount.id,
            amount: 50_000,
            currency: 'EUR',
            base_amount: 50_000,
            fx_rate: 1.0,
            vat_code: null,
            is_debit: 0,
          },
        ])
        .execute();

      const stmt = await bankStatementService.createStatement({
        account_code: 'BANK_EUR',
        start_date: '2025-01-01',
        end_date: '2025-01-31',
        transactions: [
          {
            transaction_date: '2025-01-12',
            description: 'EUR payment',
            amount: 50_000,
            currency: 'EUR',
            reference: 'INV-FX-007',
          },
        ],
      });

      const bankTxnId = stmt.transactions[0].id;

      const result = await reconciliationService.executeMatch([
        {
          bankTransactionId: bankTxnId,
          voucherId: voucher.id,
          matchType: 'exact',
          amountMatched: 50_000,
          confidence: 'high',
          signal: 'invoice_number',
        },
      ]);

      expect(result.records.length).toBe(1);
      const { fxVoucherId } = await reconciliationService.activateMatch(
        result.records[0].id,
      );
      expect(fxVoucherId).toBeNull();
    });
  });
});

/**
 * Foreign bank-account base conversion (Bug B / D3).
 *
 * When the bank account is NOT denominated in the base currency, the actual
 * settled cash (in the txn currency) must be converted to base via the country
 * plugin's reference rate, and the FX voucher must book to the BASE bank
 * account ('BANK_' + baseCurrency) in base currency. NullCountryPlugin throws
 * on real cross-currency pairs, so a fake PluginLoader is required.
 */
describe('FXRealizedService — foreign bank account base conversion', () => {
  let db: Kysely<Database>;
  let fxRealizedService: FXRealizedService;
  let voucherCounter = 0;

  /** Fake plugin: USD→EUR = 0.9; same-currency = 1.0; base currency EUR. */
  const fakePlugin: Pick<
    CountryPlugin,
    'getReferenceRate' | 'getDefaultBaseCurrency' | 'roundToBaseMinorUnits'
  > = {
    getReferenceRate(from: string, to: string): number {
      if (from === to) return 1.0;
      if (from === 'USD' && to === 'EUR') return 0.9;
      throw new Error(`Unexpected pair ${from} → ${to}`);
    },
    getDefaultBaseCurrency: () => 'EUR',
    roundToBaseMinorUnits: (amount: number) => Math.round(amount),
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

    await db
      .insertInto('voucher_sequence')
      .values({ year: '2025', last_number: 100 })
      .execute();

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
        EstoniaCountryPlugin,
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

    fxRealizedService = module.get(FXRealizedService);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('converts the actual cash to base and books the FX to the base bank account', async () => {
    // AR voucher booked at full base 9 100 EUR.
    // Bank txn on BANK_USD (currency USD != base EUR): source 1 000 GBP, fx_rate
    // 10 → actualInTxnCcy 10 000 USD. Plugin USD→EUR 0.9 → actualBaseFull 9 000.
    // Full match (matchedAmount 9 100 == booked base) → proportion 1.
    // realized = 9 100 − 9 000 = +100. Incoming (AR), realized > 0 → LOSS of 100
    // (received less base than booked), posted in EUR to BANK_EUR (the base bank
    // account), NOT BANK_USD. The conversion is what matters: without it,
    // actualBaseFull would be 10 000 (cash in USD) → realized −900 (bogus gain).
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
          amount: 1_000,
          currency: 'GBP',
          base_amount: 9_100,
          fx_rate: 9.1,
          vat_code: null,
          is_debit: 1,
        },
        {
          voucher_id: voucher.id,
          account_id: revenueAccount.id,
          amount: 1_000,
          currency: 'GBP',
          base_amount: 9_100,
          fx_rate: 9.1,
          vat_code: null,
          is_debit: 0,
        },
      ])
      .execute();

    // Insert the bank statement + foreign-leg txn directly on BANK_USD.
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

    const txn = await db
      .insertInto('bank_transaction')
      .values({
        statement_id: statement.id,
        transaction_date: '2025-01-12',
        description: 'Foreign payment received (USD account)',
        amount: 10_000, // 10 000 USD incoming
        currency: 'USD',
        source_currency: 'GBP',
        source_amount: 1_000,
        fx_rate: 10,
        reference: 'INV-FX-FCY-001',
        counterparty_iban: null,
        counterparty_descriptor: null,
        status: 'open',
        created_at: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    const result = await fxRealizedService.computeAndPost(
      voucher.id,
      txn.id,
      9_100, // matchedAmount = full booked base
    );

    expect(result.status).toBe('posted');
    const lines = result.voucher!.lines;
    expect(lines.length).toBe(2);

    // Loss: Dr FX_GAIN_LOSS / Cr BANK.
    const fxLine = lines.find((l) => l.is_debit)!;
    const bankLine = lines.find((l) => !l.is_debit)!;

    expect(bankLine.base_amount).toBe(100);
    expect(fxLine.base_amount).toBe(100);
    expect(bankLine.currency).toBe('EUR');
    expect(fxLine.currency).toBe('EUR');

    // The bank leg must book to BANK_EUR (base bank account), NOT BANK_USD.
    const eurBank = await db
      .selectFrom('account')
      .select('id')
      .where('code', '=', 'BANK_EUR')
      .executeTakeFirstOrThrow();
    expect(bankLine.account_id).toBe(eurBank.id);
  });
});
