import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException } from '@nestjs/common';
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
import { EntitiesService } from '../entities/entities.service';
import { LedgerBalanceService } from '../ledger/account/ledger-balance.service';
import { OutstandingVoucherService } from './outstanding-voucher.service';
import { PrepaymentAllocationRepository } from './prepayment-allocation.repository';
import { PrepaymentService } from './prepayment.service';
import { FxRateService } from '../fx/fx-rate.service';
import {
  FX_RATE_SOURCE,
  FxObservation,
  FxRateSource,
} from '../fx/fx-rate.types';
import { FixtureFxRateSource, fxTestProviders } from '../../test/fx-fixtures';

/**
 * Issue #215, the bank side: an advance off an unmatched bank transaction can
 * be the ledger's VERY FIRST voucher, and it converts its amount through an
 * authoritative rate lookup that may wait on the network.
 *
 * That wait is the window. While the ledger is empty the base currency and the
 * jurisdiction may still legitimately be edited, so an advance measured in EUR
 * a moment before such an edit must not land in the ledger afterwards wearing
 * the new basis. The guard is the basis the generator stamps on the draft —
 * sampled before ANY other read of the organisation, so nothing measured after
 * a change can pass as having been measured before it.
 */
describe('Prepayment measurement basis race (issue #215)', () => {
  let db: Kysely<Database>;
  let prepayments: PrepaymentService;
  let bankStatements: BankStatementService;
  let organization: OrganizationService;

  /** Runs during the next FX fetch — the deterministic interleaving point. */
  let duringRateLookup: () => Promise<void>;

  class InterleavingFxRateSource implements FxRateSource {
    readonly baseCurrency = 'EUR';
    readonly sourceId = 'ECB';
    constructor(private readonly inner: FixtureFxRateSource) {}
    async fetchObservations(
      quoteCurrency: string,
      fromDate: string,
      toDate: string,
    ): Promise<FxObservation[]> {
      await duringRateLookup();
      return this.inner.fetchObservations(quoteCurrency, fromDate, toDate);
    }
  }

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

    duringRateLookup = () => Promise.resolve();
    const fixture = new FixtureFxRateSource([
      { quoteCurrency: 'USD', rateDate: '2025-01-15', rate: 1.087 },
    ]);

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
        ...fxTestProviders(),
        {
          provide: FX_RATE_SOURCE,
          useValue: new InterleavingFxRateSource(fixture),
        },
        {
          provide: FxRateService,
          useFactory: (conn: Kysely<Database>, source: FxRateSource) =>
            new FxRateService(conn, source),
          inject: [KYSELY_MODULE_CONNECTION_TOKEN(), FX_RATE_SOURCE],
        },
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

    prepayments = module.get(PrepaymentService);
    bankStatements = module.get(BankStatementService);
    organization = module.get(OrganizationService);

    // A real rate authority is needed for there to be a lookup to wait on.
    // The ledger is empty, so this jurisdiction setup is exactly the kind of
    // pre-first-voucher edit that must keep working.
    await organization.updateOrganization({ country: 'EE' });
  });

  afterEach(async () => {
    await db.destroy();
  });

  /** An incoming USD receipt — foreign currency, so it must be converted. */
  async function seedUsdReceipt(amount: number): Promise<number> {
    const stmt = await bankStatements.createStatement({
      account_code: 'BANK_USD',
      start_date: '2025-01-01',
      end_date: '2025-01-31',
      transactions: [
        {
          transaction_date: '2025-01-15',
          description: 'Customer payment received',
          amount,
          currency: 'USD',
          counterparty_iban: null,
          status: 'open',
        },
      ],
    });
    return stmt.transactions[0].id;
  }

  const voucherCount = async () =>
    Number(
      (
        await db
          .selectFrom('voucher')
          .select((eb) => eb.fn.countAll().as('c'))
          .executeTakeFirstOrThrow()
      ).c,
    );

  it('refuses an advance measured before a basis change that landed during its rate lookup', async () => {
    const txnId = await seedUsdReceipt(25000);

    duringRateLookup = async () => {
      await organization.updateOrganization({ base_currency: 'USD' });
    };

    await expect(
      prepayments.createPrepaymentFromTransaction(txnId, undefined, {
        treatment: 'non_taxable_deposit',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    duringRateLookup = () => Promise.resolve();

    // Nothing was written: no voucher, and the transaction is untouched.
    expect(await voucherCount()).toBe(0);
    expect(
      (
        await db
          .selectFrom('bank_transaction')
          .select('status')
          .where('id', '=', txnId)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe('open');
  });

  it('refuses an advance whose JURISDICTION moved during its rate lookup', async () => {
    const txnId = await seedUsdReceipt(25000);

    // The plugin that supplies the rate and the rounding is resolved AFTER the
    // basis is stamped, so a country change in this window is caught too — the
    // case a stamp taken last would have waved through.
    duringRateLookup = async () => {
      await organization.updateOrganization({ country: 'IE' });
    };

    await expect(
      prepayments.createPrepaymentFromTransaction(txnId, undefined, {
        treatment: 'non_taxable_deposit',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    duringRateLookup = () => Promise.resolve();

    expect(await voucherCount()).toBe(0);
  });

  it('posts the advance normally when the basis holds still, and freezes it afterwards', async () => {
    const txnId = await seedUsdReceipt(25000);

    const voucher = await prepayments.createPrepaymentFromTransaction(
      txnId,
      undefined,
      { treatment: 'non_taxable_deposit' },
    );
    expect(await voucherCount()).toBe(1);

    const bankLine = await db
      .selectFrom('voucher_line')
      .innerJoin('account', 'account.id', 'voucher_line.account_id')
      .select(['voucher_line.base_amount', 'voucher_line.currency'])
      .where('voucher_line.voucher_id', '=', voucher.id)
      .where('account.code', '=', 'BANK_USD')
      .executeTakeFirstOrThrow();
    // USD 250.00 at the published 1.087 USD/EUR, measured in EUR cents.
    expect(bankLine.currency).toBe('USD');
    expect(bankLine.base_amount).toBe(Math.round(25000 / 1.087));

    // With a voucher on the books the basis is frozen outright.
    await expect(
      organization.updateOrganization({ base_currency: 'USD' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
