import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException } from '@nestjs/common';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import SqliteDb from 'better-sqlite3';
import { Database } from '../database/types';
import { migrations } from '../database/migrations';
import { OrganizationService } from './organization.service';
import { OrgContextResolver } from './org-context.resolver';
import { PluginLoader } from '../plugins/plugin-loader.service';
import { NullCountryPlugin } from '../plugins/null-country.plugin';
import { EstoniaCountryPlugin } from '../plugins/estonia-country.plugin';
import { CurrencyService } from '../currency/currency.service';
import { AccountService } from '../ledger/account/account.service';
import { LedgerBalanceService } from '../ledger/account/ledger-balance.service';
import { LedgerValidationService } from '../ledger/validation/ledger-validation.service';
import { PostingService } from '../ledger/posting/posting.service';
import { PeriodLockService } from '../reporting-periods/period-lock.service';
import { VoucherProjectionService } from '../ledger/projection/voucher-projection.service';
import { DraftVoucher } from '../ledger/voucher/types';
import { EconomicFacts } from '../ledger/projection/types';
import {
  FX_RATE_SOURCE,
  FxObservation,
  FxRateSource,
} from '../fx/fx-rate.types';
import { FixtureFxRateSource, fxTestProviders } from '../../test/fx-fixtures';
import { FxRateService } from '../fx/fx-rate.service';

/**
 * Issue #215 — the organisation's base currency and jurisdiction are the UNIT
 * of every amount already in the ledger, not ordinary profile fields.
 *
 * A VoucherLine stores `base_amount` as a bare integer. Nothing on the line
 * says which currency that integer is denominated in, or whose rate and
 * rounding produced it: that is the organisation's `base_currency` and
 * `country`. Change either after a Voucher exists and `Σ base_amount` starts
 * adding EUR-measured cents to USD-measured cents — the reported defect, where
 * an EUR-base 10000 and a USD-base 10870 summed to 20870, a number in no
 * currency at all.
 *
 * Asserted here, over real migrations, real services and an isolated in-memory
 * database:
 *  - setup before the first voucher still works, including the jurisdiction;
 *  - once ANYTHING is posted the basis is frozen, and an attempt leaves both
 *    the organisation and the aggregates exactly as they were;
 *  - an edit with no effect on the basis stays allowed, and so does every
 *    unrelated setting;
 *  - a draft measured just before a legitimate (still-empty-ledger) basis
 *    change cannot post under the new basis.
 */
describe('Ledger measurement basis settings (issue #215)', () => {
  let db: Kysely<Database>;
  let organization: OrganizationService;
  let posting: PostingService;
  let balances: LedgerBalanceService;
  let projection: VoucherProjectionService;

  const TAX_POINT = '2026-03-15';

  /**
   * An authority that runs `onFetch` before answering.
   *
   * The reported window is precisely this: `toBase` resolves the basis, then
   * AWAITS a published rate over the network, and a settings edit can land in
   * between. Driving the edit from inside the fetch makes that interleaving
   * deterministic instead of timing-dependent.
   */
  class InterleavingFxRateSource implements FxRateSource {
    readonly baseCurrency = 'EUR';
    readonly sourceId = 'ECB';
    constructor(
      private readonly inner: FixtureFxRateSource,
      private readonly onFetch: () => Promise<void>,
    ) {}
    async fetchObservations(
      quoteCurrency: string,
      fromDate: string,
      toDate: string,
    ): Promise<FxObservation[]> {
      await this.onFetch();
      return this.inner.fetchObservations(quoteCurrency, fromDate, toDate);
    }
  }

  /** Runs during the next FX fetch; set by the interleaving test only. */
  let duringRateLookup: () => Promise<void>;

  beforeEach(async () => {
    const rawDb = new SqliteDb(':memory:');
    rawDb.pragma('foreign_keys = ON');
    db = new Kysely<Database>({
      dialect: new SqliteDialect({ database: rawDb }),
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
      { quoteCurrency: 'USD', rateDate: TAX_POINT, rate: 1.087 },
    ]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: KYSELY_MODULE_CONNECTION_TOKEN(), useValue: db },
        OrganizationService,
        OrgContextResolver,
        NullCountryPlugin,
        EstoniaCountryPlugin,
        ...fxTestProviders(),
        {
          provide: FX_RATE_SOURCE,
          useValue: new InterleavingFxRateSource(fixture, () =>
            duringRateLookup(),
          ),
        },
        {
          provide: FxRateService,
          useFactory: (conn: Kysely<Database>, source: FxRateSource) =>
            new FxRateService(conn, source),
          inject: [KYSELY_MODULE_CONNECTION_TOKEN(), FX_RATE_SOURCE],
        },
        PluginLoader,
        CurrencyService,
        AccountService,
        LedgerBalanceService,
        LedgerValidationService,
        PostingService,
        PeriodLockService,
        VoucherProjectionService,
      ],
    }).compile();

    organization = module.get(OrganizationService);
    posting = module.get(PostingService);
    balances = module.get(LedgerBalanceService);
    projection = module.get(VoucherProjectionService);
  });

  afterEach(async () => {
    await db.destroy();
  });

  // ── helpers ──────────────────────────────────────────────────────────────

  /** The reported EUR 100 sale, booked at the EUR base: AR 10000 / revenue. */
  const eurSale = (cents = 10000): DraftVoucher => ({
    tax_point_date: TAX_POINT,
    lines: [
      {
        account_code: 'AR',
        amount: cents,
        currency: 'EUR',
        base_amount: cents,
        fx_rate: 1.0,
        is_debit: true,
      },
      {
        account_code: 'REVENUE',
        amount: cents,
        currency: 'EUR',
        base_amount: cents,
        fx_rate: 1.0,
        is_debit: false,
      },
    ],
  });

  const arNet = () => balances.getLedgerNet({ codes: ['AR'] });

  const orgRow = () =>
    db
      .selectFrom('organization')
      .select(['country', 'base_currency', 'name', 'iban'])
      .executeTakeFirstOrThrow();

  const voucherCount = async () =>
    Number(
      (
        await db
          .selectFrom('voucher')
          .select((eb) => eb.fn.countAll().as('c'))
          .executeTakeFirstOrThrow()
      ).c,
    );

  // ── setup before the first voucher stays open ────────────────────────────

  it('lets the basis be set up freely while no voucher exists', async () => {
    // The seed is IE with no override (→ EUR from the plugin). Both halves of
    // the basis move, one after the other, on an empty ledger.
    expect(await orgRow()).toMatchObject({
      country: 'IE',
      base_currency: null,
    });

    await organization.updateOrganization({ base_currency: 'USD' });
    expect((await orgRow()).base_currency).toBe('USD');

    await organization.updateOrganization({ country: 'EE' });
    expect((await orgRow()).country).toBe('EE');

    await organization.updateOrganization({
      country: 'IE',
      base_currency: null,
    });
    expect(await orgRow()).toMatchObject({
      country: 'IE',
      base_currency: null,
    });
  });

  // ── the reported case ────────────────────────────────────────────────────

  it('refuses a base-currency change once a voucher is posted, and the aggregate stays in one basis', async () => {
    await posting.postVoucher(eurSale());
    expect(await arNet()).toBe(10000);

    await expect(
      organization.updateOrganization({ base_currency: 'USD' }),
    ).rejects.toBeInstanceOf(ConflictException);

    // The organisation did not move…
    expect(await orgRow()).toMatchObject({
      country: 'IE',
      base_currency: null,
    });

    // …so the second EUR 100 sale is measured in the same basis as the first,
    // and the aggregate is 20000 EUR-cents rather than the reported 20870 of
    // two different currencies added together.
    await posting.postVoucher(eurSale());
    expect(await arNet()).toBe(20000);
  });

  it('names the current and the attempted basis so the refusal is actionable', async () => {
    await posting.postVoucher(eurSale());
    await expect(
      organization.updateOrganization({ base_currency: 'USD' }),
    ).rejects.toThrow(/EUR \(IE\).*USD \(IE\)/s);
  });

  // ── jurisdiction gets the same protection ────────────────────────────────

  it('refuses a country change once a voucher is posted, even with the currency untouched', async () => {
    await posting.postVoucher(eurSale());

    // EE and the neutral plugin both default to EUR, so the CURRENCY does not
    // move at all here. The jurisdiction does, and with it the rate source, the
    // minor-unit rounding and the VAT treatment the posted line was booked
    // under — so it is refused on the same terms.
    await expect(
      organization.updateOrganization({ country: 'EE' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect((await orgRow()).country).toBe('IE');
  });

  it('refuses a combined currency + jurisdiction change as one', async () => {
    await posting.postVoucher(eurSale());
    await expect(
      organization.updateOrganization({ country: 'EE', base_currency: 'USD' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(await orgRow()).toMatchObject({
      country: 'IE',
      base_currency: null,
    });
  });

  // ── what must keep working after posting ─────────────────────────────────

  it('allows an edit that leaves the EFFECTIVE basis where it was', async () => {
    await posting.postVoucher(eurSale());

    // Writing the plugin's own default into the override, and clearing it
    // again, changes the column but not the measurement — so neither is a
    // basis change, and neither is refused.
    await organization.updateOrganization({ base_currency: 'EUR' });
    expect((await orgRow()).base_currency).toBe('EUR');

    await organization.updateOrganization({ base_currency: null });
    expect((await orgRow()).base_currency).toBeNull();

    // Restating the country it already has is likewise a no-op.
    await organization.updateOrganization({ country: 'IE' });
    expect((await orgRow()).country).toBe('IE');
  });

  it('leaves every unrelated setting editable after posting', async () => {
    await posting.postVoucher(eurSale());

    const updated = await organization.updateOrganization({
      name: 'Posted Ltd',
      iban: 'EE382200221020145685',
      vat_registered: true,
      vat_registration_number: 'IE1234567X',
    });
    expect(updated).toMatchObject({
      name: 'Posted Ltd',
      iban: 'EE382200221020145685',
      vat_registered: true,
    });
  });

  it('treats a PUT that names no field as the no-op it always was', async () => {
    await posting.postVoucher(eurSale());
    const before = await orgRow();
    await expect(organization.updateOrganization({})).resolves.toMatchObject({
      country: 'IE',
    });
    expect(await orgRow()).toEqual(before);
  });

  // ── the trigger is posting, not a balance ────────────────────────────────

  it('stays frozen for a ledger whose entries net to zero', async () => {
    const posted = await posting.postVoucher(eurSale());
    await posting.postVoucher({
      ...eurSale(),
      reverses_id: posted.id,
      lines: eurSale().lines.map((l) => ({ ...l, is_debit: !l.is_debit })),
    });

    // Nothing is outstanding — and the history is still measured in EUR.
    expect(await arNet()).toBe(0);
    await expect(
      organization.updateOrganization({ base_currency: 'USD' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  // ── the stale-measurement window ─────────────────────────────────────────

  it('refuses a draft measured before a (then legitimate) basis change', async () => {
    // A real rate authority is needed to have a rate to wait ON, so the
    // jurisdiction is set first — still legitimate, the ledger is empty.
    await organization.updateOrganization({ country: 'EE' });

    // The ledger is still empty, so the edit below is legitimate at the moment
    // it is made. What must not happen is the draft measured just before it
    // landing in the ledger afterwards, labelled with a basis it was never
    // measured in.
    const facts: EconomicFacts = {
      grossAmount: 10000,
      vatAmount: 0,
      currency: 'USD',
      taxPointDate: TAX_POINT,
      category: 'sales',
    } as EconomicFacts;

    // Fires while the projection is awaiting the published USD rate — the exact
    // window between resolving the basis and booking the amounts.
    duringRateLookup = async () => {
      await organization.updateOrganization({ base_currency: 'USD' });
    };

    const draft = await projection.project(facts, 'sale');
    duringRateLookup = () => Promise.resolve();

    // The draft records the basis it was MEASURED in, not the one now on file.
    expect(draft.measured_basis).toEqual({
      country: 'EE',
      base_currency: null,
    });
    expect((await orgRow()).base_currency).toBe('USD');

    await expect(posting.postVoucher(draft)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(await voucherCount()).toBe(0);
    expect(await arNet()).toBe(0);
  });

  it('posts normally when the basis held still through the measurement', async () => {
    await organization.updateOrganization({ country: 'EE' });
    const facts: EconomicFacts = {
      grossAmount: 10000,
      vatAmount: 0,
      currency: 'USD',
      taxPointDate: TAX_POINT,
      category: 'sales',
    } as EconomicFacts;

    const draft = await projection.project(facts, 'sale');
    await posting.postVoucher(draft);

    // 100.00 USD at the published 1.087 USD/EUR, in EUR cents.
    expect(await arNet()).toBe(Math.round(10000 / 1.087));
    // And the basis is frozen from here on.
    await expect(
      organization.updateOrganization({ base_currency: 'USD' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
