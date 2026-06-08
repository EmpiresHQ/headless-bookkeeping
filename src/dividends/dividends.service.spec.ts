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
import { PluginLoader } from '../plugins/plugin-loader.service';
import { CurrencyService } from '../currency/currency.service';
import {
  NullCountryPlugin,
  NULL_VAT_CODE,
} from '../plugins/null-country.plugin';
import {
  CountryPlugin,
  OrgContext,
  SupplierFacts,
  CategoryMappingResult,
  CrossBorderResolution,
  VATCode,
} from '../plugins/country-plugin.interface';
import { DividendsService, COUNTRY_PLUGIN_TOKEN } from './dividends.service';

/**
 * Integration test for dividend distribution (declaration + settlement).
 * Uses real SQLite in-memory with full migrations (real-DI test, G2 gate).
 *
 * Tests:
 * 1. Declare → voucher posted Dr RETAINED_EARNINGS / Cr DIVIDEND_PAYABLE
 * 2. Settle → bank txn reconciled against declaration voucher
 * 3. Withholding split when plugin rate > 0
 * 4. Profits-check path (soft warning in null plugin)
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
        PluginLoader,
        CurrencyService,
        NullCountryPlugin,
        { provide: COUNTRY_PLUGIN_TOKEN, useExisting: NullCountryPlugin },
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
    }

    beforeEach(async () => {
      module = await Test.createTestingModule({
        providers: [
          { provide: KYSELY_MODULE_CONNECTION_TOKEN(), useValue: db },
          AccountService,
          LedgerValidationService,
          PostingService,
          PeriodLockService,
          BankTransactionRepository,
          BankStatementService,
          OrganizationService,
          PluginLoader,
          CurrencyService,
          NullCountryPlugin,
          MockWithholdingPlugin,
          { provide: COUNTRY_PLUGIN_TOKEN, useClass: MockWithholdingPlugin },
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
});
