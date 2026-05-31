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
import { LedgerValidationService } from '../ledger/validation/ledger-validation.service';
import { ReconciliationService } from './reconciliation.service';
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
        FXRealizedService,
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

  describe('auto-post via executeMatch', () => {
    it('auto-posts FX voucher when a foreign-currency match is executed', async () => {
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

      // Match record created.
      expect(result.records.length).toBe(1);

      // FX voucher auto-posted.
      expect(result.fxResults.length).toBe(1);
      const fxResult = result.fxResults[0];
      expect(fxResult.status).toBe('posted');
      expect(fxResult.voucher).toBeDefined();
      expect(fxResult.voucher!.lines.length).toBe(2);

      // Verify the FX voucher was persisted.
      const fxVoucherId = fxResult.voucher!.id;
      const persistedLines = await db
        .selectFrom('voucher_line')
        .selectAll()
        .where('voucher_id', '=', fxVoucherId)
        .execute();
      expect(persistedLines.length).toBe(2);
    });

    it('returns no_fx in fxResults for same-currency matches', async () => {
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
      expect(result.fxResults.length).toBe(1);
      expect(result.fxResults[0].status).toBe('no_fx');
    });
  });
});
