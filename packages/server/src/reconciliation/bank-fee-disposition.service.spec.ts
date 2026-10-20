import { fxTestProviders } from '../../test/fx-fixtures';
import { BadRequestException, ConflictException } from '@nestjs/common';
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
import { OrganizationService } from '../organization/organization.service';
import { NullCountryPlugin } from '../plugins/null-country.plugin';
import { EstoniaCountryPlugin } from '../plugins/estonia-country.plugin';
import { PluginLoader } from '../plugins/plugin-loader.service';
import { CurrencyService } from '../currency/currency.service';
import { OrgContextResolver } from '../organization/org-context.resolver';
import { BankFeeDispositionService } from './bank-fee-disposition.service';

/**
 * Issue #403's fee-separation regression: the explicit bank-fee disposition —
 * the bank's OWN evidenced conversion fee, booked LAST, in CASH units, so
 * principal + fee reconcile the full statement debit without duplicating an
 * expense or bank line. Real SQLite, real posting path; the settlement match
 * is seeded directly (its own flow is covered by the reconciliation suites
 * and root's full-path probes), with the CASH-consumed column
 * (`cash_base_amount`) recorded exactly as the real activation seam does.
 */
describe('BankFeeDispositionService (integration, issue #403)', () => {
  let db: Kysely<Database>;
  let service: BankFeeDispositionService;
  let organizationService: OrganizationService;

  beforeEach(async () => {
    db = new Kysely<Database>({
      dialect: new SqliteDialect({ database: new SqliteDb(':memory:') }),
    });
    const { error } = await new Migrator({
      db,
      provider: { getMigrations: () => Promise.resolve(migrations) },
    }).migrateToLatest();
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
        OrganizationService,
        NullCountryPlugin,
        EstoniaCountryPlugin,
        ...fxTestProviders(),
        PluginLoader,
        CurrencyService,
        OrgContextResolver,
        BankFeeDispositionService,
      ],
    }).compile();
    service = module.get(BankFeeDispositionService);
    organizationService = module.get(OrganizationService);
    await organizationService.updateOrganization({ country: 'EE' });
  });

  afterEach(async () => {
    await db.destroy();
  });

  /** A converted settlement line: DKK 60 → debit 8.11, principal 8.03 + fee 0.08. */
  const seedLine = async (over?: {
    debit?: number;
    fee?: number | null;
    cash?: number | null;
    booked?: number | null;
  }): Promise<number> => {
    const account = await db
      .selectFrom('account')
      .select('id')
      .where('code', '=', 'BANK_EUR')
      .executeTakeFirstOrThrow();
    const stmt = await db
      .insertInto('bank_statement')
      .values({
        account_id: account.id,
        start_date: '2026-06-19',
        end_date: '2026-06-19',
        uploaded_at: 0,
        file_path: null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const txn = await db
      .insertInto('bank_transaction')
      .values({
        statement_id: stmt.id,
        transaction_date: '2026-06-19',
        description: 'Next House Copenhagen DKK 60; fee 0.08',
        amount: -(over?.debit ?? 811),
        currency: 'EUR',
        source_currency: 'DKK',
        source_amount: 6000,
        fx_rate: 0.1338333,
        conversion_fee: over?.fee === undefined ? 8 : over.fee,
        counterparty_iban: null,
        counterparty_descriptor: 'NEXT HOUSE COPENHAGEN',
        reference: null,
        status: 'open',
        created_at: 0,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    // The purchase's settlement match, seeded exactly as the real activation
    // seam records it: CASH consumed and BOOKED base. `cash: null` means
    // "seed no match" (the fee-first case) — an `in`-based check, because ??
    // would turn a deliberate null back into the default.
    const seedMatch = !(over && 'cash' in over && over.cash === null);
    const cash = seedMatch ? (over?.cash ?? 803) : 803;
    const booked = seedMatch ? (over?.booked ?? 803) : 803;
    if (seedMatch) {
      const voucher = await db
        .insertInto('voucher')
        .values({
          voucher_number: 'V403',
          tax_point_date: '2026-06-19',
          posted_at: 0,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await db
        .insertInto('reconciliation_match')
        .values({
          bank_transaction_id: txn.id,
          voucher_id: voucher.id,
          match_type: 'exact',
          amount_matched: booked,
          cash_base_amount: cash,
          status: 'active',
          signal: 'invoice_number',
          created_at: 0,
        })
        .execute();
    }
    return txn.id;
  };

  it('books the evidenced fee LAST, completing the line\u2019s full cash debit (8.03 + 0.08 = 8.11)', async () => {
    const txnId = await seedLine();
    const voucher = await service.markAsBankFee(txnId);
    expect(voucher.lines).toHaveLength(2);
    for (const l of voucher.lines) {
      expect(l.amount).toBe(8);
      expect(l.base_amount).toBe(8);
    }
    const feeAccountId = (
      await db
        .selectFrom('account')
        .select('id')
        .where('code', '=', 'EXPENSE_BANK_FEE')
        .executeTakeFirstOrThrow()
    ).id;
    const bankAccountId = (
      await db
        .selectFrom('account')
        .select('id')
        .where('code', '=', 'BANK_EUR')
        .executeTakeFirstOrThrow()
    ).id;
    expect(voucher.lines.some((l) => l.account_id === feeAccountId)).toBe(true);
    expect(voucher.lines.some((l) => l.account_id === bankAccountId)).toBe(
      true,
    );

    // The fee portion is reconciled and the line is fully disposed.
    const matches = await db
      .selectFrom('reconciliation_match')
      .selectAll()
      .where('bank_transaction_id', '=', txnId)
      .execute();
    const totalCash = matches.reduce(
      (sum, m) => sum + (m.cash_base_amount ?? m.amount_matched),
      0,
    );
    expect(totalCash).toBe(811); // principal 803 + fee 8 = the full debit
    const txn = await db
      .selectFrom('bank_transaction')
      .select('status')
      .where('id', '=', txnId)
      .executeTakeFirstOrThrow();
    expect(txn.status).toBe('bank_fee');

    // Idempotent by state: a repeat is refused, nothing double-booked.
    await expect(service.markAsBankFee(txnId)).rejects.toThrow(
      BadRequestException,
    );
    const feeLegs = await db
      .selectFrom('voucher_line')
      .selectAll()
      .where('account_id', '=', feeAccountId)
      .execute();
    expect(feeLegs).toHaveLength(1); // the fee leg exists exactly once
  });

  it('refuses a fee-first booking with no financial mutation (the principal must be reconciled first)', async () => {
    const txnId = await seedLine({ cash: null, booked: null });
    await expect(service.markAsBankFee(txnId)).rejects.toThrow(
      ConflictException,
    );
    // Nothing posted, nothing matched, the line stays open.
    const feeAccountId = (
      await db
        .selectFrom('account')
        .select('id')
        .where('code', '=', 'EXPENSE_BANK_FEE')
        .executeTakeFirstOrThrow()
    ).id;
    expect(
      await db
        .selectFrom('voucher_line')
        .selectAll()
        .where('account_id', '=', feeAccountId)
        .execute(),
    ).toHaveLength(0);
    const txn = await db
      .selectFrom('bank_transaction')
      .select('status')
      .where('id', '=', txnId)
      .executeTakeFirstOrThrow();
    expect(txn.status).toBe('open');
  });

  it('refuses a fee that does not equal the unallocated CASH remainder (never booked base)', async () => {
    // A reference-valued purchase: BOOKED 857, but the bank's cash consumed
    // only 803 (+ its realized FX leg) — the fee's capacity is the CASH
    // remainder 8, not the booked figure.
    const txnId = await seedLine({ booked: 857 });
    const voucher = await service.markAsBankFee(txnId);
    expect(voucher.lines[0].amount).toBe(8);
    const matches = await db
      .selectFrom('reconciliation_match')
      .selectAll()
      .where('bank_transaction_id', '=', txnId)
      .execute();
    const totalCash = matches.reduce(
      (sum, m) => sum + (m.cash_base_amount ?? m.amount_matched),
      0,
    );
    expect(totalCash).toBe(811);
  });

  it('refuses a line with no explicitly evidenced fee (NULL is never a guessed residual)', async () => {
    const txnId = await seedLine({ fee: null });
    await expect(service.markAsBankFee(txnId)).rejects.toThrow(
      /no explicitly evidenced conversion fee/i,
    );
  });

  it('refuses an explicitly evidenced ZERO fee (nothing bookable)', async () => {
    const txnId = await seedLine({ fee: 0 });
    await expect(service.markAsBankFee(txnId)).rejects.toThrow(
      /not a bookable charge/i,
    );
  });

  it('refuses a fee exceeding the line\u2019s debit (conflicting figures)', async () => {
    const txnId = await seedLine({ debit: 811, fee: 900 });
    await expect(service.markAsBankFee(txnId)).rejects.toThrow(
      /exceeds its debit/i,
    );
  });
});
