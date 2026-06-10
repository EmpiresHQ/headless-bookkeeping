import { Test, TestingModule } from '@nestjs/testing';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import SqliteDb from 'better-sqlite3';
import { Database } from '../database/types';
import { migrations } from '../database/migrations';
import { AccountService } from '../ledger/account/account.service';
import { LedgerBalanceService } from '../ledger/account/ledger-balance.service';
import { LedgerValidationService } from '../ledger/validation/ledger-validation.service';
import { PostingService } from '../ledger/posting/posting.service';
import { PeriodLockService } from '../reporting-periods/period-lock.service';
import { BankTransactionRepository } from '../bank/bank-transaction.repository';
import { BankStatementService } from '../bank/bank-statement.service';
import { OrganizationService } from '../organization/organization.service';
import { OrgContextResolver } from '../organization/org-context.resolver';
import { PluginLoader } from '../plugins/plugin-loader.service';
import { CurrencyService } from '../currency/currency.service';
import { NullCountryPlugin } from '../plugins/null-country.plugin';
import { EstoniaCountryPlugin } from '../plugins/estonia-country.plugin';
import { NULL_VAT_CODE } from '../ledger/posting/vat-constants';
import {
  CountryPlugin,
  OrgContext,
  SupplierFacts,
  CategoryMappingResult,
  CrossBorderResolution,
  VATCode,
} from '../plugins/country-plugin.interface';
import {
  ExpenseTreatmentPreview,
  VatComputation,
} from '../plugins/country-plugin-retrieval.interface';
import { DividendsService } from './dividends.service';

/**
 * Integration test for dividend distribution (declaration + settlement).
 * Uses real SQLite in-memory with full migrations (real-DI test, G2 gate).
 *
 * Tests:
 * 1. Declare → voucher posted Dr RETAINED_EARNINGS / Cr DIVIDEND_PAYABLE
 * 2. Settle → bank txn reconciled against declaration voucher
 * 3. Withholding split when plugin rate > 0
 * 4. Profits-check path (soft warning in null plugin)
 * 5. Real-resolution: EE org resolves EstoniaCountryPlugin → DISTRIBUTION_TAX_PAYABLE booked
 */
describe('DividendsService (integration)', () => {
  let db: Kysely<Database>;
  let dividendsService: DividendsService;
  let bankStatementService: BankStatementService;

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

    const nullPlugin = new NullCountryPlugin();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: KYSELY_MODULE_CONNECTION_TOKEN(), useValue: db },
        AccountService,
        LedgerBalanceService,
        LedgerValidationService,
        PostingService,
        PeriodLockService,
        BankTransactionRepository,
        BankStatementService,
        OrganizationService,
        {
          provide: PluginLoader,
          useValue: { resolve: () => nullPlugin },
        },
        CurrencyService,
        OrgContextResolver,
        DividendsService,
      ],
    }).compile();

    dividendsService = module.get(DividendsService);
    bankStatementService = module.get(BankStatementService);
  });

  afterEach(async () => {
    await db.destroy();
  });

  // ── Helpers ──────────────────────────────────────────────────────────

  async function seedBankTransaction(
    amount: number,
    status: string = 'dividend',
  ) {
    const stmt = await bankStatementService.createStatement({
      account_code: 'BANK_EUR',
      start_date: '2025-06-01',
      end_date: '2025-06-30',
      transactions: [
        {
          transaction_date: '2025-06-15',
          description: 'Dividend payment to owner',
          amount,
          currency: 'EUR',
          status: status as 'dividend' | 'open',
        },
      ],
    });
    return stmt.transactions[0];
  }

  // ── Declaration: Dr RETAINED_EARNINGS / Cr DIVIDEND_PAYABLE ─────────

  describe('declaration', () => {
    it('posts Dr RETAINED_EARNINGS / Cr DIVIDEND_PAYABLE (no withholding)', async () => {
      const result = await dividendsService.declare({
        gross_amount: 10000, // €100.00
        tax_point_date: '2025-06-15',
        reason: 'Q2 dividend',
      });

      expect(result.voucher_id).toBeGreaterThan(0);
      expect(result.gross_amount).toBe(10000);
      expect(result.net_payable).toBe(10000);
      expect(result.withholding_amount).toBe(0);

      // Verify voucher lines.
      const lines = await db
        .selectFrom('voucher_line')
        .innerJoin('account', 'account.id', 'voucher_line.account_id')
        .select('account.code')
        .select('voucher_line.base_amount')
        .select('voucher_line.is_debit')
        .where('voucher_line.voucher_id', '=', result.voucher_id)
        .execute();

      expect(lines).toHaveLength(2);

      const debitLine = lines.find((l) => l.is_debit === 1);
      const creditLine = lines.find((l) => l.is_debit === 0);

      expect(debitLine).toBeDefined();
      expect(creditLine).toBeDefined();
      expect(debitLine!.code).toBe('RETAINED_EARNINGS');
      expect(creditLine!.code).toBe('DIVIDEND_PAYABLE');
      expect(debitLine!.base_amount).toBe(10000);
      expect(creditLine!.base_amount).toBe(10000);
    });

    it('rejects zero or negative gross_amount', async () => {
      await expect(
        dividendsService.declare({
          gross_amount: 0,
          tax_point_date: '2025-06-15',
        }),
      ).rejects.toThrow('gross_amount must be positive');

      await expect(
        dividendsService.declare({
          gross_amount: -5000,
          tax_point_date: '2025-06-15',
        }),
      ).rejects.toThrow('gross_amount must be positive');
    });
  });

  // ── Settlement: bank txn reconciled against declaration ─────────────

  describe('settlement', () => {
    it('settles dividend against bank transaction, creates reconciliation_match', async () => {
      // 1. Declare a dividend.
      const declaration = await dividendsService.declare({
        gross_amount: 5000,
        tax_point_date: '2025-06-15',
      });

      // 2. Create a bank transaction with status 'dividend'.
      const txn = await seedBankTransaction(-5000, 'dividend');

      // 3. Settle.
      const settlement = await dividendsService.settle(
        txn.id,
        declaration.voucher_id,
      );

      expect(settlement.voucher_id).toBeGreaterThan(0);
      expect(settlement.reconciliation_match_id).toBeGreaterThan(0);
      expect(settlement.amount_settled).toBe(5000);

      // Verify settlement voucher: Dr DIVIDEND_PAYABLE / Cr BANK_EUR.
      const settlementLines = await db
        .selectFrom('voucher_line')
        .innerJoin('account', 'account.id', 'voucher_line.account_id')
        .select('account.code')
        .select('voucher_line.base_amount')
        .select('voucher_line.is_debit')
        .where('voucher_line.voucher_id', '=', settlement.voucher_id)
        .execute();

      expect(settlementLines).toHaveLength(2);

      const debitLine = settlementLines.find((l) => l.is_debit === 1);
      const creditLine = settlementLines.find((l) => l.is_debit === 0);

      expect(debitLine).toBeDefined();
      expect(creditLine).toBeDefined();
      expect(debitLine!.code).toBe('DIVIDEND_PAYABLE');
      expect(creditLine!.code).toBe('BANK_EUR');
      expect(debitLine!.base_amount).toBe(5000);
      expect(creditLine!.base_amount).toBe(5000);

      // Verify reconciliation_match links bank txn to declaration voucher.
      const match = await db
        .selectFrom('reconciliation_match')
        .select('bank_transaction_id')
        .select('voucher_id')
        .select('amount_matched')
        .select('match_type')
        .where('id', '=', settlement.reconciliation_match_id)
        .executeTakeFirstOrThrow();

      expect(match.bank_transaction_id).toBe(txn.id);
      expect(match.voucher_id).toBe(declaration.voucher_id);
      expect(match.amount_matched).toBe(5000);
      expect(match.match_type).toBe('exact');
    });

    it('rejects a non-existent bank transaction', async () => {
      const declaration = await dividendsService.declare({
        gross_amount: 3000,
        tax_point_date: '2025-06-15',
      });

      await expect(
        dividendsService.settle(99999, declaration.voucher_id),
      ).rejects.toThrow('not found');
    });

    it('rejects a non-dividend bank transaction', async () => {
      const declaration = await dividendsService.declare({
        gross_amount: 3000,
        tax_point_date: '2025-06-15',
      });

      const txn = await seedBankTransaction(-3000, 'open');

      await expect(
        dividendsService.settle(txn.id, declaration.voucher_id),
      ).rejects.toThrow('not a dividend');
    });

    it('rejects a non-existent declaration voucher', async () => {
      const txn = await seedBankTransaction(-3000, 'dividend');

      await expect(dividendsService.settle(txn.id, 99999)).rejects.toThrow(
        'not found',
      );
    });
  });

  // ── Withholding split (mock plugin with rate > 0) ───────────────────

  describe('withholding split', () => {
    let module: TestingModule;
    let withholdingDividendsService: DividendsService;

    /** Mock plugin with 27% withholding tax (Danish-style). */
    class MockWithholdingPlugin implements CountryPlugin {
      getName(): string {
        return 'mock-withholding';
      }
      getVATCodes(): VATCode[] {
        return [NULL_VAT_CODE];
      }
      resolveCategoryMapping(
        _category: string,
        _supplierFacts: SupplierFacts,
        _orgContext: OrgContext,
      ): CategoryMappingResult {
        return { accountCode: 'EXPENSE_OTHER', vatCode: NULL_VAT_CODE };
      }
      getPeriodFrequencyOptions(): string[] {
        return ['yearly'];
      }
      getDefaultPeriodFrequency(): string {
        return 'yearly';
      }
      getDefaultBaseCurrency(): string {
        return 'EUR';
      }
      getReferenceRate(
        fromCurrency: string,
        toCurrency: string,
        _date: string,
      ): number {
        if (fromCurrency === toCurrency) return 1.0;
        throw new Error('Cross-currency not supported');
      }
      roundToBaseMinorUnits(amount: number): number {
        return Math.round(amount);
      }
      validateVATCode(
        vatCode: string,
        _context: { supplier: SupplierFacts; org: OrgContext },
      ): boolean {
        return vatCode === NULL_VAT_CODE;
      }
      resolvePersonalDispositionAccount(orgType: string): string {
        return orgType === 'sole_proprietor'
          ? 'OWNERS_DRAWINGS'
          : 'SHAREHOLDER_LOAN';
      }
      resolveCrossBorderTreatment(
        _supplierFacts: SupplierFacts,
        _orgContext: OrgContext,
        _context: { vatCharged: boolean },
      ): CrossBorderResolution {
        return { treatment: 'domestic', vatCode: NULL_VAT_CODE };
      }
      dividendWithholdingRate(_orgContext: OrgContext): number {
        return 0.27; // 27% withholding
      }
      assertDistributable(
        _grossAmount: number,
        _retainedEarnings: number,
        _orgContext: OrgContext,
      ): boolean {
        return true;
      }
      getVatRate(_vatCode: string): number {
        return 0;
      }
      computeVat(netMinorUnits: number, _vatCode: string): VatComputation {
        return {
          netMinorUnits,
          vatMinorUnits: 0,
          grossMinorUnits: netMinorUnits,
          rate: 0,
        };
      }
      previewExpenseTreatment(
        _category: string,
        _supplierFacts: SupplierFacts,
        _orgContext: OrgContext,
      ): ExpenseTreatmentPreview {
        return {
          accountCode: 'EXPENSE_OTHER',
          vatCode: NULL_VAT_CODE,
          rate: 0,
          treatment: 'domestic',
        };
      }
      getVatRegistrationThreshold(_orgContext: OrgContext): number | null {
        return null;
      }
      resolveDistributionTax(
        _netToOwner: number,
        _orgContext: OrgContext,
      ): { accountCode: string; amount: number } | null {
        return null;
      }
    }

    beforeEach(async () => {
      const mockPlugin = new MockWithholdingPlugin();

      module = await Test.createTestingModule({
        providers: [
          { provide: KYSELY_MODULE_CONNECTION_TOKEN(), useValue: db },
          AccountService,
          LedgerBalanceService,
          LedgerValidationService,
          PostingService,
          PeriodLockService,
          BankTransactionRepository,
          BankStatementService,
          OrganizationService,
          {
            provide: PluginLoader,
            useValue: { resolve: () => mockPlugin },
          },
          CurrencyService,
          OrgContextResolver,
          DividendsService,
        ],
      }).compile();

      withholdingDividendsService = module.get(DividendsService);
    });

    it('splits declaration into net payable + withholding tax', async () => {
      const result = await withholdingDividendsService.declare({
        gross_amount: 10000, // €100.00
        tax_point_date: '2025-06-15',
      });

      expect(result.gross_amount).toBe(10000);
      expect(result.withholding_amount).toBe(2700); // 27% of 10000
      expect(result.net_payable).toBe(7300); // 10000 - 2700

      // Verify voucher has 3 lines.
      const lines = await db
        .selectFrom('voucher_line')
        .innerJoin('account', 'account.id', 'voucher_line.account_id')
        .select('account.code')
        .select('voucher_line.base_amount')
        .select('voucher_line.is_debit')
        .where('voucher_line.voucher_id', '=', result.voucher_id)
        .execute();

      expect(lines).toHaveLength(3);

      const debitLine = lines.find((l) => l.is_debit === 1);
      const creditLines = lines.filter((l) => l.is_debit === 0);

      expect(debitLine).toBeDefined();
      expect(debitLine!.code).toBe('RETAINED_EARNINGS');
      expect(debitLine!.base_amount).toBe(10000);

      const payableLine = creditLines.find(
        (l) => l.code === 'DIVIDEND_PAYABLE',
      );
      const withholdingLine = creditLines.find(
        (l) => l.code === 'DIVIDEND_WITHHOLDING_TAX_PAYABLE',
      );

      expect(payableLine).toBeDefined();
      expect(payableLine!.base_amount).toBe(7300);
      expect(withholdingLine).toBeDefined();
      expect(withholdingLine!.base_amount).toBe(2700);

      // Verify balance: debit = sum of credits.
      const totalCredits = creditLines.reduce(
        (sum, l) => sum + l.base_amount,
        0,
      );
      expect(totalCredits).toBe(debitLine!.base_amount);
    });
  });

  // ── Profits-check path ──────────────────────────────────────────────

  describe('profits-check', () => {
    it('soft-warns but does not block when dividend exceeds retained earnings (null plugin)', async () => {
      // No retained earnings seeded — balance is 0.
      // Null plugin soft-checks (warns, doesn't block).
      const result = await dividendsService.declare({
        gross_amount: 50000, // €500.00 — exceeds any reasonable retained earnings
        tax_point_date: '2025-06-15',
      });

      // Should still succeed (soft check).
      expect(result.voucher_id).toBeGreaterThan(0);
      expect(result.gross_amount).toBe(50000);
    });
  });

  // ── Distribution tax on top (EE-style 22/78) ────────────────────────

  describe('distribution tax on top', () => {
    let module: TestingModule;
    let eeDividendsService: DividendsService;

    /**
     * Mock plugin simulating EE distribution-tax behaviour:
     *   - No withholding (rate = 0)
     *   - resolveDistributionTax → DISTRIBUTION_TAX_PAYABLE, round(net*22/78)
     *   - assertDistributable always true (cap enforced externally in real EE plugin)
     */
    class MockDistributionTaxPlugin implements CountryPlugin {
      getName(): string {
        return 'mock-dist-tax';
      }
      getVATCodes(): VATCode[] {
        return [NULL_VAT_CODE];
      }
      resolveCategoryMapping(
        _category: string,
        _supplierFacts: SupplierFacts,
        _orgContext: OrgContext,
      ): CategoryMappingResult {
        return { accountCode: 'EXPENSE_OTHER', vatCode: NULL_VAT_CODE };
      }
      getPeriodFrequencyOptions(): string[] {
        return ['monthly'];
      }
      getDefaultPeriodFrequency(): string {
        return 'monthly';
      }
      getDefaultBaseCurrency(): string {
        return 'EUR';
      }
      getReferenceRate(
        fromCurrency: string,
        toCurrency: string,
        _date: string,
      ): number {
        if (fromCurrency === toCurrency) return 1.0;
        throw new Error('Cross-currency not supported');
      }
      roundToBaseMinorUnits(amount: number): number {
        return Math.round(amount);
      }
      validateVATCode(
        vatCode: string,
        _context: { supplier: SupplierFacts; org: OrgContext },
      ): boolean {
        return vatCode === NULL_VAT_CODE;
      }
      resolvePersonalDispositionAccount(orgType: string): string {
        return orgType === 'sole_proprietor'
          ? 'OWNERS_DRAWINGS'
          : 'SHAREHOLDER_LOAN';
      }
      resolveCrossBorderTreatment(
        _supplierFacts: SupplierFacts,
        _orgContext: OrgContext,
        _context: { vatCharged: boolean },
      ): CrossBorderResolution {
        return { treatment: 'domestic', vatCode: NULL_VAT_CODE };
      }
      dividendWithholdingRate(_orgContext: OrgContext): number {
        return 0.0; // EE has no withholding
      }
      assertDistributable(
        _grossAmount: number,
        _retainedEarnings: number,
        _orgContext: OrgContext,
      ): boolean {
        return true; // cap always passes in mock; EE plugin adds its own logic
      }
      getVatRate(_vatCode: string): number {
        return 0;
      }
      computeVat(netMinorUnits: number, _vatCode: string): VatComputation {
        return {
          netMinorUnits,
          vatMinorUnits: 0,
          grossMinorUnits: netMinorUnits,
          rate: 0,
        };
      }
      previewExpenseTreatment(
        _category: string,
        _supplierFacts: SupplierFacts,
        _orgContext: OrgContext,
      ): ExpenseTreatmentPreview {
        return {
          accountCode: 'EXPENSE_OTHER',
          vatCode: NULL_VAT_CODE,
          rate: 0,
          treatment: 'domestic',
        };
      }
      getVatRegistrationThreshold(_orgContext: OrgContext): number | null {
        return null;
      }
      resolveDistributionTax(
        netToOwner: number,
        _orgContext: OrgContext,
      ): { accountCode: string; amount: number } | null {
        return {
          accountCode: 'DISTRIBUTION_TAX_PAYABLE',
          amount: Math.round((netToOwner * 22) / 78),
        };
      }
    }

    beforeEach(async () => {
      const mockPlugin = new MockDistributionTaxPlugin();

      module = await Test.createTestingModule({
        providers: [
          { provide: KYSELY_MODULE_CONNECTION_TOKEN(), useValue: db },
          AccountService,
          LedgerBalanceService,
          LedgerValidationService,
          PostingService,
          PeriodLockService,
          BankTransactionRepository,
          BankStatementService,
          OrganizationService,
          {
            provide: PluginLoader,
            useValue: { resolve: () => mockPlugin },
          },
          CurrencyService,
          OrgContextResolver,
          DividendsService,
        ],
      }).compile();

      eeDividendsService = module.get(DividendsService);

      // Seed retained earnings: post a revenue entry so distributable profits
      // comfortably exceed gross + distribution tax (128205).
      // We post a manual voucher: Cr REVENUE / Dr AR for 200000 cents = €2000.
      const postingService = module.get(PostingService);
      await postingService.postVoucher({
        tax_point_date: '2026-01-01',
        reason: 'Seed revenue for EE distribution-tax test',
        lines: [
          {
            account_code: 'AR',
            amount: 200000,
            currency: 'EUR',
            base_amount: 200000,
            fx_rate: 1.0,
            is_debit: true,
          },
          {
            account_code: 'REVENUE',
            amount: 200000,
            currency: 'EUR',
            base_amount: 200000,
            fx_rate: 1.0,
            is_debit: false,
          },
        ],
      });
    });

    it('books distribution tax on top: Dr RETAINED_EARNINGS (net+tax) / Cr DIVIDEND_PAYABLE (net) / Cr DISTRIBUTION_TAX_PAYABLE (tax)', async () => {
      // gross 100000, withholding 0 → net 100000
      // distTax = round(100000 * 22 / 78) = 28205
      // retainedDebit = 100000 + 28205 = 128205
      const result = await eeDividendsService.declare({
        gross_amount: 100000,
        tax_point_date: '2026-06-15',
      });

      const lines = await db
        .selectFrom('voucher_line')
        .innerJoin('account', 'account.id', 'voucher_line.account_id')
        .select([
          'account.code',
          'voucher_line.base_amount',
          'voucher_line.is_debit',
        ])
        .where('voucher_line.voucher_id', '=', result.voucher_id)
        .execute();

      const re = lines.find((l) => l.code === 'RETAINED_EARNINGS');
      const pay = lines.find((l) => l.code === 'DIVIDEND_PAYABLE');
      const tax = lines.find((l) => l.code === 'DISTRIBUTION_TAX_PAYABLE');

      // RETAINED_EARNINGS debit = gross + distTax
      expect(re).toBeDefined();
      expect(re!.is_debit).toBe(1);
      expect(re!.base_amount).toBe(128205);

      // DIVIDEND_PAYABLE credit = net to owner (no withholding)
      expect(pay).toBeDefined();
      expect(pay!.base_amount).toBe(100000);

      // DISTRIBUTION_TAX_PAYABLE credit = distTax
      expect(tax).toBeDefined();
      expect(tax!.base_amount).toBe(28205);

      // Balance: debit === sum of credits
      expect(re!.base_amount).toBe(pay!.base_amount + tax!.base_amount);
    });
  });

  // ── Real-resolution: EE org → EstoniaCountryPlugin fires in prod path ─

  describe('real plugin resolution (regression guard)', () => {
    /**
     * This test uses the REAL PluginLoader (not a stub) to prove that when
     * organization.country = 'EE', PluginLoader.resolve('EE') returns
     * EstoniaCountryPlugin and DISTRIBUTION_TAX_PAYABLE is booked.
     *
     * This is the regression guard for the original bug where DividendsService
     * injected a hardcoded NullCountryPlugin via COUNTRY_PLUGIN_TOKEN, causing
     * EE distribution tax to never fire in production.
     */
    let module: TestingModule;
    let eeService: DividendsService;

    beforeEach(async () => {
      module = await Test.createTestingModule({
        providers: [
          { provide: KYSELY_MODULE_CONNECTION_TOKEN(), useValue: db },
          AccountService,
          LedgerBalanceService,
          LedgerValidationService,
          PostingService,
          PeriodLockService,
          BankTransactionRepository,
          BankStatementService,
          OrganizationService,
          // Real PluginLoader with real plugins — no stubs.
          NullCountryPlugin,
          EstoniaCountryPlugin,
          PluginLoader,
          CurrencyService,
          OrgContextResolver,
          DividendsService,
        ],
      }).compile();

      eeService = module.get(DividendsService);

      // Set org country to 'EE' so PluginLoader.resolve('EE') returns
      // EstoniaCountryPlugin (not the null fallback).
      await db
        .updateTable('organization')
        .set({ country: 'EE' })
        .where('id', '=', 1)
        .execute();

      // Seed enough distributable profits for the declare to pass the EE cap check.
      // EE assertDistributable requires retainedEarnings >= gross + round(gross*22/78).
      // For gross=100000: totalHit = 100000 + 28205 = 128205. Seed 200000 to be safe.
      const postingService = module.get(PostingService);
      await postingService.postVoucher({
        tax_point_date: '2026-01-01',
        reason: 'Seed revenue — real EE plugin resolution regression guard',
        lines: [
          {
            account_code: 'AR',
            amount: 200000,
            currency: 'EUR',
            base_amount: 200000,
            fx_rate: 1.0,
            is_debit: true,
          },
          {
            account_code: 'REVENUE',
            amount: 200000,
            currency: 'EUR',
            base_amount: 200000,
            fx_rate: 1.0,
            is_debit: false,
          },
        ],
      });
    });

    it('routes EE org through real EstoniaCountryPlugin: DISTRIBUTION_TAX_PAYABLE line IS booked', async () => {
      // gross 100000, EE withholding 0 → net 100000
      // EE distTax = round(100000 * 22 / 78) = 28205
      // retainedDebit = 128205
      const result = await eeService.declare({
        gross_amount: 100000,
        tax_point_date: '2026-06-15',
        reason: 'EE real-resolution test',
      });

      const lines = await db
        .selectFrom('voucher_line')
        .innerJoin('account', 'account.id', 'voucher_line.account_id')
        .select([
          'account.code',
          'voucher_line.base_amount',
          'voucher_line.is_debit',
        ])
        .where('voucher_line.voucher_id', '=', result.voucher_id)
        .execute();

      const re = lines.find((l) => l.code === 'RETAINED_EARNINGS');
      const pay = lines.find((l) => l.code === 'DIVIDEND_PAYABLE');
      const tax = lines.find((l) => l.code === 'DISTRIBUTION_TAX_PAYABLE');

      // The EE plugin MUST have fired: DISTRIBUTION_TAX_PAYABLE line is present.
      expect(tax).toBeDefined();
      expect(tax!.base_amount).toBe(28205); // round(100000 * 22 / 78)

      // RETAINED_EARNINGS debit = gross + distTax (total equity hit)
      expect(re).toBeDefined();
      expect(re!.is_debit).toBe(1);
      expect(re!.base_amount).toBe(128205); // 100000 + 28205

      // DIVIDEND_PAYABLE credit = net to owner (no withholding in EE)
      expect(pay).toBeDefined();
      expect(pay!.base_amount).toBe(100000);

      // Voucher balances: debit === sum of credits
      expect(re!.base_amount).toBe(pay!.base_amount + tax!.base_amount);

      // 3 lines total: RE + DIVIDEND_PAYABLE + DISTRIBUTION_TAX_PAYABLE (EE has no withholding)
      expect(lines).toHaveLength(3);
    });
  });
});
