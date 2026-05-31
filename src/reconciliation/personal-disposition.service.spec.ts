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
  });
});
