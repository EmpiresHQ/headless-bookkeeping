import { Test, TestingModule } from '@nestjs/testing';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import SqliteDb from 'better-sqlite3';
import { Database } from '../database/types';
import { migrations } from '../database/migrations';
import { OrganizationService } from '../organization/organization.service';
import { OrgContextResolver } from '../organization/org-context.resolver';
import { NullCountryPlugin } from '../plugins/null-country.plugin';
import { EstoniaCountryPlugin } from '../plugins/estonia-country.plugin';
import { PluginLoader } from '../plugins/plugin-loader.service';
import { CurrencyService } from '../currency/currency.service';
import { AccountService } from '../ledger/account/account.service';
import { LedgerValidationService } from '../ledger/validation/ledger-validation.service';
import { PostingService } from '../ledger/posting/posting.service';
import { PeriodLockService } from '../reporting-periods/period-lock.service';
import { VoucherProjectionService } from '../ledger/projection/voucher-projection.service';
import { FxProvenanceAuditService } from './fx-provenance-audit.service';
import { FxRateUnavailableError } from './fx-rate.types';
import { fxTestProviders, FixtureRate } from '../../test/fx-fixtures';

/**
 * End of the #203 chain, exercised through the real posting path: a rate is
 * resolved from an authority, applied, and PERSISTED on the voucher line with
 * the publication date and source it came from — and a date with no supported
 * rate is refused rather than posted at an invented one.
 */
describe('FX provenance on posted vouchers (issue #203)', () => {
  // Fri 2026-03-06 and Mon 2026-03-09 carry DIFFERENT published rates; the
  // weekend between them carries none.
  const RATES: FixtureRate[] = [
    { quoteCurrency: 'USD', rateDate: '2026-03-06', rate: 1.25 },
    { quoteCurrency: 'USD', rateDate: '2026-03-09', rate: 1.0 },
  ];

  let db: Kysely<Database>;
  let projection: VoucherProjectionService;
  let posting: PostingService;
  let audit: FxProvenanceAuditService;

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
    if (error) {
      throw error instanceof Error ? error : new Error('Migration failed');
    }
    // The deployment this issue was reported against.
    await db
      .updateTable('organization')
      .set({ country: 'EE', base_currency: null })
      .execute();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: KYSELY_MODULE_CONNECTION_TOKEN(), useValue: db },
        OrganizationService,
        NullCountryPlugin,
        EstoniaCountryPlugin,
        ...fxTestProviders(RATES),
        PluginLoader,
        OrgContextResolver,
        CurrencyService,
        AccountService,
        LedgerValidationService,
        PeriodLockService,
        PostingService,
        VoucherProjectionService,
        FxProvenanceAuditService,
      ],
    }).compile();

    projection = module.get(VoucherProjectionService);
    posting = module.get(PostingService);
    audit = module.get(FxProvenanceAuditService);
  });

  afterEach(() => db.destroy());

  const postUsdExpense = async (taxPointDate: string) => {
    const draft = await projection.project(
      {
        category: 'software',
        grossAmount: 10_000,
        vatAmount: 0,
        currency: 'USD',
        taxPointDate,
        supplierCountry: 'EE',
        goodsVsServices: 'services',
      },
      'purchase',
    );
    return posting.postVoucher(draft);
  };

  it('persists the applied rate, its publication date and its source', async () => {
    const voucher = await postUsdExpense('2026-03-06');

    for (const line of voucher.lines) {
      expect(line.fx_rate_source).toBe('ECB');
      expect(line.fx_rate_date).toBe('2026-03-06');
      expect(line.fx_rate).toBeCloseTo(1 / 1.25, 12);
    }
    // 10 000 USD ÷ 1.25 USD-per-EUR = 8 000 EUR.
    const debit = voucher.lines.find((l) => l.is_debit);
    expect(debit?.base_amount).toBe(8000);
  });

  it('books two different dates at the two different published rates', async () => {
    const friday = await postUsdExpense('2026-03-06');
    const monday = await postUsdExpense('2026-03-09');

    const fridayDebit = friday.lines.find((l) => l.is_debit);
    const mondayDebit = monday.lines.find((l) => l.is_debit);

    // The defect posted both of these at one constant. They must differ.
    expect(fridayDebit?.base_amount).toBe(8000);
    expect(mondayDebit?.base_amount).toBe(10_000);
    expect(fridayDebit?.fx_rate_date).toBe('2026-03-06');
    expect(mondayDebit?.fx_rate_date).toBe('2026-03-09');
  });

  it('a weekend tax point records the FRIDAY publication it actually used', async () => {
    const saturday = await postUsdExpense('2026-03-07');
    const line = saturday.lines[0];

    expect(line.fx_rate_date).toBe('2026-03-06');
    // The line's own tax point is the Saturday; the rate's date is not. The
    // difference is recorded rather than being inferable only by guesswork.
    expect(saturday.tax_point_date).toBe('2026-03-07');
    expect(line.fx_rate_date).not.toBe(saturday.tax_point_date);
  });

  it('HOLDS the posting when no authoritative rate governs — nothing reaches the ledger', async () => {
    // 2026-03-02 precedes every publication in the fixture.
    await expect(postUsdExpense('2026-03-02')).rejects.toThrow(
      FxRateUnavailableError,
    );

    const vouchers = await db.selectFrom('voucher').selectAll().execute();
    expect(vouchers).toHaveLength(0);
  });

  it('refuses a currency the authority does not quote', async () => {
    await expect(
      projection.project(
        {
          category: 'software',
          grossAmount: 10_000,
          vatAmount: 0,
          currency: 'JPY',
          taxPointDate: '2026-03-06',
          supplierCountry: 'EE',
          goodsVsServices: 'services',
        },
        'purchase',
      ),
    ).rejects.toThrow(FxRateUnavailableError);
  });

  it('a base-currency posting records an IDENTITY conversion, not a blank', async () => {
    const draft = await projection.project(
      {
        category: 'software',
        grossAmount: 10_000,
        vatAmount: 0,
        currency: 'EUR',
        taxPointDate: '2026-03-06',
        supplierCountry: 'EE',
        goodsVsServices: 'services',
      },
      'purchase',
    );
    const voucher = await posting.postVoucher(draft);

    expect(voucher.lines[0].fx_rate_source).toBe('identity');
    expect(voucher.lines[0].fx_rate_source).not.toBeNull();
  });

  describe('historical assessment (read-only)', () => {
    it('separates attributed lines from legacy unattributed ones, and mutates nothing', async () => {
      await postUsdExpense('2026-03-06');

      // A legacy line: posted at a rate with no provenance, on two different
      // dates — the shape the placeholder produced.
      const account = await db
        .selectFrom('account')
        .select('id')
        .executeTakeFirstOrThrow();
      for (const [i, date] of ['2024-04-12', '2026-09-02'].entries()) {
        const v = await db
          .insertInto('voucher')
          .values({
            voucher_number: `LEGACY-${i}`,
            tax_point_date: date,
            posted_at: 1_700_000_000,
            previous_hash: null,
            reverses_id: null,
            corrects_object_type: null,
            corrects_object_id: null,
            reason: null,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        await db
          .insertInto('voucher_line')
          .values({
            voucher_id: v.id,
            account_id: account.id,
            amount: 10_000,
            currency: 'USD',
            base_amount: 9200,
            fx_rate: 0.92,
            fx_rate_date: null,
            fx_rate_source: null,
            vat_code: null,
            is_debit: 1,
          })
          .execute();
      }

      const before = await db.selectFrom('voucher_line').selectAll().execute();
      const result = await audit.assess();
      const after = await db.selectFrom('voucher_line').selectAll().execute();

      // Read-only, verifiably: the audit is evidence, not a correction.
      expect(after).toEqual(before);

      expect(result.unattributed_line_count).toBe(2);
      expect(result.suspected_date_blind).toEqual([
        expect.objectContaining({
          currency: 'USD',
          fx_rate: 0.92,
          fx_rate_source: null,
          line_count: 2,
          first_tax_point_date: '2024-04-12',
          last_tax_point_date: '2026-09-02',
        }),
      ]);
      // The newly posted, attributed lines are NOT in the flagged population.
      expect(result.groups.some((g) => g.fx_rate_source === 'ECB')).toBe(true);
    });

    it('does not flag a single-date unattributed rate as date-blind', async () => {
      const account = await db
        .selectFrom('account')
        .select('id')
        .executeTakeFirstOrThrow();
      const v = await db
        .insertInto('voucher')
        .values({
          voucher_number: 'LEGACY-ONE-DAY',
          tax_point_date: '2026-08-24',
          posted_at: 1_700_000_000,
          previous_hash: null,
          reverses_id: null,
          corrects_object_type: null,
          corrects_object_id: null,
          reason: null,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await db
        .insertInto('voucher_line')
        .values({
          voucher_id: v.id,
          account_id: account.id,
          amount: 10_000,
          currency: 'USD',
          base_amount: 8573,
          fx_rate: 0.8573388203017832,
          fx_rate_date: null,
          fx_rate_source: null,
          vat_code: null,
          is_debit: 1,
        })
        .execute();

      const result = await audit.assess();
      // Unattributed, so still reported — but NOT presented as date-blind,
      // and emphatically not presented as verified either.
      expect(result.unattributed_line_count).toBe(1);
      expect(result.suspected_date_blind).toEqual([]);
    });
  });
});
