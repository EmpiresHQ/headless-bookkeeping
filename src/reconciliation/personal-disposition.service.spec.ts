import { BadRequestException } from '@nestjs/common';
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
import { BankTransactionRepository } from '../bank/bank-transaction.repository';
import { BankStatementService } from '../bank/bank-statement.service';
import { OrganizationService } from '../organization/organization.service';
import { NullCountryPlugin } from '../plugins/null-country.plugin';
import { PluginLoader } from '../plugins/plugin-loader.service';
import { CurrencyService } from '../currency/currency.service';
import { CountryPlugin } from '../plugins/country-plugin.interface';
import { PersonalDispositionService } from './personal-disposition.service';

/**
 * Integration test for personal disposition.
 * Uses real SQLite in-memory with full migrations (real-DI test, G2 gate).
 *
 * Tests that the disposition account is resolved via the plugin (not hardcoded):
 * - sole_proprietor → OWNERS_DRAWINGS (equity contra)
 * - company → SHAREHOLDER_LOAN (receivable-from-owner, asset)
 */
describe('PersonalDispositionService (integration)', () => {
  let db: Kysely<Database>;
  let personalDispositionService: PersonalDispositionService;
  let bankStatementService: BankStatementService;
  let organizationService: OrganizationService;

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
        BankTransactionRepository,
        BankStatementService,
        OrganizationService,
        NullCountryPlugin,
        PluginLoader,
        CurrencyService,
        PersonalDispositionService,
      ],
    }).compile();

    personalDispositionService = module.get(PersonalDispositionService);
    bankStatementService = module.get(BankStatementService);
    organizationService = module.get(OrganizationService);
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
          description: 'Personal expense - corporate card',
          amount,
          currency: 'EUR',
          status: status as 'open' | 'personal',
        },
      ],
    });
    return stmt.transactions[0];
  }

  async function setOrgType(orgType: 'company' | 'sole_proprietor') {
    await organizationService.updateOrganization({ org_type: orgType });
  }

  // ── Company → SHAREHOLDER_LOAN ──────────────────────────────────────

  describe('company org_type', () => {
    beforeEach(async () => {
      // Default is 'company', but be explicit.
      await setOrgType('company');
    });

    it('posts Dr SHAREHOLDER_LOAN / Cr BANK_EUR via plugin', async () => {
      const txn = await seedBankTransaction(-5000);

      const voucher = await personalDispositionService.markAsPersonal(txn.id);

      expect(voucher.id).toBeGreaterThan(0);
      expect(voucher.lines).toHaveLength(2);

      const debitLine = voucher.lines.find((l) => l.is_debit);
      const creditLine = voucher.lines.find((l) => !l.is_debit);

      expect(debitLine).toBeDefined();
      expect(creditLine).toBeDefined();

      const debitAccount = await db
        .selectFrom('account')
        .select('code')
        .where('id', '=', debitLine!.account_id)
        .executeTakeFirstOrThrow();
      expect(debitAccount.code).toBe('SHAREHOLDER_LOAN');

      const creditAccount = await db
        .selectFrom('account')
        .select('code')
        .where('id', '=', creditLine!.account_id)
        .executeTakeFirstOrThrow();
      expect(creditAccount.code).toBe('BANK_EUR');

      expect(debitLine!.base_amount).toBe(5000);
      expect(creditLine!.base_amount).toBe(5000);
    });

    it('updates the bank transaction status to personal', async () => {
      const txn = await seedBankTransaction(-3000);

      await personalDispositionService.markAsPersonal(txn.id);

      const updated = await db
        .selectFrom('bank_transaction')
        .select('status')
        .where('id', '=', txn.id)
        .executeTakeFirstOrThrow();
      expect(updated.status).toBe('personal');
    });
  });

  // ── Sole proprietor → OWNERS_DRAWINGS ───────────────────────────────

  describe('sole_proprietor org_type', () => {
    beforeEach(async () => {
      await setOrgType('sole_proprietor');
    });

    it('posts Dr OWNERS_DRAWINGS / Cr BANK_EUR via plugin', async () => {
      const txn = await seedBankTransaction(-7500);

      const voucher = await personalDispositionService.markAsPersonal(txn.id);

      expect(voucher.id).toBeGreaterThan(0);
      expect(voucher.lines).toHaveLength(2);

      const debitLine = voucher.lines.find((l) => l.is_debit);
      const creditLine = voucher.lines.find((l) => !l.is_debit);

      expect(debitLine).toBeDefined();
      expect(creditLine).toBeDefined();

      const debitAccount = await db
        .selectFrom('account')
        .select('code')
        .where('id', '=', debitLine!.account_id)
        .executeTakeFirstOrThrow();
      expect(debitAccount.code).toBe('OWNERS_DRAWINGS');

      const creditAccount = await db
        .selectFrom('account')
        .select('code')
        .where('id', '=', creditLine!.account_id)
        .executeTakeFirstOrThrow();
      expect(creditAccount.code).toBe('BANK_EUR');

      expect(debitLine!.base_amount).toBe(7500);
      expect(creditLine!.base_amount).toBe(7500);
    });
  });

  // ── Validation ──────────────────────────────────────────────────────

  describe('validation', () => {
    it('rejects a non-existent transaction', async () => {
      await expect(
        personalDispositionService.markAsPersonal(99999),
      ).rejects.toThrow('not found');
    });

    it('rejects a non-open transaction', async () => {
      const txn = await seedBankTransaction(-2000, 'personal');

      await expect(
        personalDispositionService.markAsPersonal(txn.id),
      ).rejects.toThrow('not open');
    });

    it('rejects an incoming (non-outflow) transaction', async () => {
      const txn = await seedBankTransaction(50000);

      await expect(
        personalDispositionService.markAsPersonal(txn.id),
      ).rejects.toThrow(BadRequestException);
    });
  });
});

/**
 * Cross-currency personal disposition: the bank leg must resolve the REAL
 * bank account (e.g. BANK_USD) and convert the foreign amount to base
 * currency (EUR) via the country plugin's reference rate.
 *
 * Uses a fake PluginLoader so USD→EUR = 0.9. (NullCountryPlugin throws on a
 * real cross-currency pair, so a fake is required.)
 */
describe('PersonalDispositionService — cross-currency bank account', () => {
  let db: Kysely<Database>;
  let personalDispositionService: PersonalDispositionService;
  let bankStatementService: BankStatementService;

  /** Fake plugin: USD→EUR = 0.9; same-currency = 1.0; delegates account resolution. */
  const fakePlugin: Pick<
    CountryPlugin,
    'getReferenceRate' | 'getDefaultBaseCurrency' | 'resolvePersonalDispositionAccount'
  > = {
    getReferenceRate(from: string, to: string): number {
      if (from === to) return 1.0;
      if (from === 'USD' && to === 'EUR') return 0.9;
      throw new Error(`Unexpected pair ${from} → ${to}`);
    },
    getDefaultBaseCurrency: () => 'EUR',
    resolvePersonalDispositionAccount: (orgType: string) =>
      orgType === 'sole_proprietor' ? 'OWNERS_DRAWINGS' : 'SHAREHOLDER_LOAN',
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
        BankTransactionRepository,
        BankStatementService,
        OrganizationService,
        NullCountryPlugin,
        PluginLoader,
        CurrencyService,
        PersonalDispositionService,
      ],
    })
      .overrideProvider(PluginLoader)
      .useValue(fakeLoader)
      .compile();

    personalDispositionService = module.get(PersonalDispositionService);
    bankStatementService = module.get(BankStatementService);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('resolves BANK_USD and converts the foreign outflow to base EUR', async () => {
    const stmt = await bankStatementService.createStatement({
      account_code: 'BANK_USD',
      start_date: '2025-01-01',
      end_date: '2025-01-31',
      transactions: [
        {
          transaction_date: '2025-01-15',
          description: 'Personal expense - USD card',
          amount: -10000,
          currency: 'USD',
          status: 'open',
        },
      ],
    });
    const txn = stmt.transactions[0];

    const voucher = await personalDispositionService.markAsPersonal(txn.id);

    const debitLine = voucher.lines.find((l) => l.is_debit)!;
    const creditLine = voucher.lines.find((l) => !l.is_debit)!;

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

    // Disposition leg (debit): base currency EUR, base amount, rate 1.0.
    expect(debitLine.currency).toBe('EUR');
    expect(debitLine.base_amount).toBe(9000);
    expect(debitLine.amount).toBe(9000);
    expect(debitLine.fx_rate).toBe(1.0);
    expect(debitLine.is_debit).toBe(true);
  });
});
