import { Provider } from '@nestjs/common';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import SqliteDb from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { Database } from '../src/database/types';
import { migrations } from '../src/database/migrations';
import { FxRateService } from '../src/fx/fx-rate.service';
import {
  FX_RATE_SOURCE,
  FxObservation,
  FxRateSource,
  FxRateUnavailableError,
} from '../src/fx/fx-rate.types';

/**
 * Deterministic FX test doubles, injected AT THE SOURCE BOUNDARY
 * ({@link FxRateSource}) — never as a "use fixed rates" flag inside the
 * production path, which is the defect issue #203 removes.
 *
 * Everything below the boundary is the real thing: the real cache table, the
 * real lookback/fallback policy, the real cross-rate arithmetic. Only the
 * upstream authority is replaced, so a test exercises the code that ships.
 */

/** A fixture observation, in the ECB's own convention: units per 1 EUR. */
export interface FixtureRate {
  quoteCurrency: string;
  rateDate: string;
  rate: number;
}

/**
 * A stand-in authority backed by a fixed list of publications.
 *
 * Its calendar is the fixture's: a date with no entry is a date the authority
 * published nothing (a weekend or holiday), which is exactly the case the
 * fallback rule must handle. A currency absent from `quotedCurrencies` is one
 * the authority does not quote at all, and is refused the way the real ECB
 * refuses an unknown series key.
 */
export class FixtureFxRateSource implements FxRateSource {
  readonly baseCurrency = 'EUR';

  /** Every (quoteCurrency, from, to) it was asked for — call-order evidence. */
  readonly calls: { quoteCurrency: string; from: string; to: string }[] = [];

  constructor(
    private readonly rates: FixtureRate[],
    readonly sourceId = 'ECB',
    private readonly quotedCurrencies: string[] = [
      ...new Set(rates.map((r) => r.quoteCurrency)),
    ],
    /** When set, every fetch fails with it — the "upstream is down" case. */
    private readonly failWith?: string,
  ) {}

  fetchObservations(
    quoteCurrency: string,
    fromDate: string,
    toDate: string,
  ): Promise<FxObservation[]> {
    this.calls.push({ quoteCurrency, from: fromDate, to: toDate });

    if (this.failWith) {
      return Promise.reject(
        new FxRateUnavailableError(
          quoteCurrency,
          this.baseCurrency,
          toDate,
          this.failWith,
        ),
      );
    }
    if (!this.quotedCurrencies.includes(quoteCurrency)) {
      return Promise.reject(
        new FxRateUnavailableError(
          quoteCurrency,
          this.baseCurrency,
          toDate,
          `fixture authority does not quote ${quoteCurrency}`,
        ),
      );
    }

    return Promise.resolve(
      this.rates
        .filter(
          (r) =>
            r.quoteCurrency === quoteCurrency &&
            r.rateDate >= fromDate &&
            r.rateDate <= toDate,
        )
        .map((r) => ({
          baseCurrency: this.baseCurrency,
          quoteCurrency: r.quoteCurrency,
          rateDate: r.rateDate,
          rate: r.rate,
        }))
        .sort((a, b) => a.rateDate.localeCompare(b.rateDate)),
    );
  }
}

/**
 * Real ECB reference rates, used as fixtures so the numbers in tests are the
 * numbers the authority actually published. Verified 2026-09-20 against
 * https://data-api.ecb.europa.eu/service/data/EXR/D.{USD,GBP}.EUR.SP00.A
 *
 * Note what the calendar shows, and why these dates were chosen:
 *   - 2020-01-01 is a TARGET closing day — NO publication. 2020-01-02 is the
 *     first of that year.
 *   - 2026-08-29 is a Saturday and 2026-08-30 a Sunday — no publication; the
 *     Friday 2026-08-28 rate is the one in force across the weekend.
 */
export const ECB_FIXTURE_RATES: FixtureRate[] = [
  // ── Around the 2020 New Year TARGET closing day ──
  { quoteCurrency: 'USD', rateDate: '2019-12-31', rate: 1.1234 },
  { quoteCurrency: 'USD', rateDate: '2020-01-02', rate: 1.1193 },
  { quoteCurrency: 'USD', rateDate: '2020-01-03', rate: 1.1147 },
  { quoteCurrency: 'GBP', rateDate: '2019-12-31', rate: 0.8508 },
  { quoteCurrency: 'GBP', rateDate: '2020-01-02', rate: 0.84828 },
  // ── A 2026 week ending in a weekend gap ──
  { quoteCurrency: 'USD', rateDate: '2026-08-28', rate: 1.1702 },
  { quoteCurrency: 'USD', rateDate: '2026-08-31', rate: 1.1688 },
  { quoteCurrency: 'USD', rateDate: '2026-09-01', rate: 1.1655 },
  { quoteCurrency: 'GBP', rateDate: '2026-08-28', rate: 0.8661 },
  { quoteCurrency: 'GBP', rateDate: '2026-09-01', rate: 0.8672 },
];

/**
 * The rate the issue-#202 settlement scenarios were written against.
 *
 * Those tests were built on the EE plugin's placeholder USD→EUR 0.92, which
 * issue #203 removes. The numeric scenarios are worth keeping — they are about
 * booked-vs-actual cash, caps and correction links, not about FX sourcing — so
 * the same arithmetic is restated here as EXPLICIT publications by a fixture
 * authority, in the ECB's own convention (units per 1 EUR, hence the
 * reciprocal). Nothing about it reaches production: it is a fixture passed to
 * {@link fxTestProviders}, not a constant inside a plugin.
 */
const USD_PER_EUR_FOR_092 = 1 / 0.92;

/**
 * Publications covering the dates the #202 suites post on, so USD→EUR resolves
 * to 0.92 on each of them exactly as before.
 */
export const SETTLEMENT_SCENARIO_RATES: FixtureRate[] = [
  '2026-05-15',
  '2026-05-18',
  '2026-05-20',
  '2026-06-01',
].map((rateDate) => ({
  quoteCurrency: 'USD',
  rateDate,
  rate: USD_PER_EUR_FOR_092,
}));

/**
 * A real {@link FxRateService} — real cache table, real policy handling — over
 * an isolated in-memory SQLite database and a fixture authority.
 *
 * Returns the database too, so a test can close it and can inspect what the
 * service cached.
 */
export async function fixtureFxRateService(
  rates: FixtureRate[] = ECB_FIXTURE_RATES,
  source = new FixtureFxRateSource(rates),
): Promise<{
  service: FxRateService;
  db: Kysely<Database>;
  source: FxRateSource;
}> {
  const rawDb = new SqliteDb(':memory:');
  rawDb.pragma('foreign_keys = ON');
  const db = new Kysely<Database>({
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
  return { service: new FxRateService(db, source), db, source };
}

/**
 * An {@link FxRateService} for a test that never converts currency.
 *
 * Any call fails loudly. A suite about VAT codes or category mapping should
 * not silently acquire an FX rate from somewhere — if one of these throws, the
 * test is exercising a path it meant to leave alone.
 */
export function unusedFxRateService(): FxRateService {
  return {
    resolve: () =>
      Promise.reject(
        new Error(
          'unusedFxRateService: this test declared it performs no currency ' +
            'conversion, but a reference rate was requested',
        ),
      ),
  } as unknown as FxRateService;
}

/**
 * Nest providers that wire {@link FxRateService} to a fixture authority.
 *
 * For any test module that provides `EstoniaCountryPlugin` (which now depends
 * on a rate lookup) together with a Kysely connection. Spread into the
 * module's `providers` array; the rest of the FX path stays real.
 */
export function fxTestProviders(
  rates: FixtureRate[] = ECB_FIXTURE_RATES,
): Provider[] {
  return [
    { provide: FX_RATE_SOURCE, useValue: new FixtureFxRateSource(rates) },
    {
      provide: FxRateService,
      // The Kysely connection is OPTIONAL here because these same providers
      // are spread into two kinds of test module: integration modules that own
      // a migrated database (where the real rate cache is exercised), and pure
      // unit modules that have no database at all. A unit module cannot post,
      // so it cannot legitimately need a rate — it gets the loud stub instead
      // of a half-wired service that would fail with a confusing DI message.
      useFactory: (db?: Kysely<Database>) =>
        db
          ? new FxRateService(db, new FixtureFxRateSource(rates))
          : unusedFxRateService(),
      inject: [{ token: KYSELY_MODULE_CONNECTION_TOKEN(), optional: true }],
    },
  ];
}
